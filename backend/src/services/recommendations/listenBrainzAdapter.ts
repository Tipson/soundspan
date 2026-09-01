import axios from "axios";
import pLimit from "p-limit";
import { prisma } from "../../utils/db";
import { decrypt } from "../../utils/encryption";
import { logger } from "../../utils/logger";
import { ytMusicService } from "../youtubeMusic";
import { buildCanonicalRecordingKey } from "./canonicalIdentity";
import type { RecommendationCandidate } from "./types";

const log = logger.child("ListenBrainzRecommendations");
const LISTENBRAINZ_API = "https://api.listenbrainz.org/1";
const LISTENBRAINZ_TIMEOUT_MS = 7_000;
const LISTENBRAINZ_TOTAL_DEADLINE_MS = 6_000;
const LAST_GOOD_OPERATION_TIMEOUT_MS = 250;
const LAST_GOOD_TTL_SECONDS = 6 * 60 * 60;
const CIRCUIT_FAILURE_LIMIT = 3;
const CIRCUIT_OPEN_MS = 5 * 60 * 1_000;
const MAX_CANDIDATES = 50;
const limitListenBrainzPlayableResolution = pLimit(2);

export interface ListenBrainzConnection {
    username: string;
    token: string;
    tags?: string[];
}

export interface ListenBrainzRecordingMetadata {
    recordingMbid: string;
    title: string;
    artist: string;
    album?: string | null;
}

export interface ListenBrainzRecommendationCandidateBatch {
    candidates: RecommendationCandidate[];
    degradedSources: string[];
}

interface ListenBrainzAdapterDependencies {
    loadConnection: (userId: string) => Promise<ListenBrainzConnection | null>;
    fetchCollaborativeMbids: (
        connection: ListenBrainzConnection,
        count: number,
        offset: number,
    ) => Promise<string[]>;
    fetchTagRadioMetadata: (
        connection: ListenBrainzConnection,
        count: number,
    ) => Promise<ListenBrainzRecordingMetadata[]>;
    fetchRecordingMetadata: (
        connection: ListenBrainzConnection,
        recordingMbids: string[],
    ) => Promise<ListenBrainzRecordingMetadata[]>;
    resolvePlayable: (
        userId: string,
        metadata: ListenBrainzRecordingMetadata,
        signal?: AbortSignal,
    ) => Promise<{ videoId: string; title: string; duration: number } | null>;
    readLastGood: (
        userId: string,
        signal?: AbortSignal,
    ) => Promise<RecommendationCandidate[] | null>;
    writeLastGood: (
        userId: string,
        tracks: RecommendationCandidate[],
        signal?: AbortSignal,
    ) => Promise<void>;
    now: () => Date;
}

interface CircuitState {
    failures: number;
    openUntil: number;
}

function parseTasteTags(value: unknown): string[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const raw = record.genres ?? record.selectedGenres ?? record.tags;
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 5);
}

function recordingMbidFromIdentifier(value: unknown): string | null {
    const identifiers = Array.isArray(value) ? value : [value];
    for (const identifier of identifiers) {
        if (typeof identifier !== "string") continue;
        const match = identifier.match(
            /(?:recording\/|recording:)([0-9a-f-]{8,})/iu,
        );
        if (match?.[1]) return match[1].toLocaleLowerCase("en-US");
    }
    return null;
}

function parseJspfMetadata(payload: unknown): ListenBrainzRecordingMetadata[] {
    if (!payload || typeof payload !== "object") return [];
    const root = payload as Record<string, any>;
    const tracks =
        root.playlist?.track ??
        root.payload?.jspf?.playlist?.track ??
        root.jspf?.playlist?.track ??
        [];
    if (!Array.isArray(tracks)) return [];
    return tracks.flatMap((track: unknown) => {
        if (!track || typeof track !== "object") return [];
        const row = track as Record<string, any>;
        const recordingMbid =
            recordingMbidFromIdentifier(row.identifier) ??
            String(
                row.recording_mbid ??
                    row.extension?.["https://musicbrainz.org/doc/jspf#track"]
                        ?.additional_metadata?.recording_mbid ??
                    "",
            ).trim();
        const title = String(row.title ?? row.track_name ?? "").trim();
        const artist = String(
            row.creator ?? row.artist_name ?? row.artist ?? "",
        ).trim();
        if (!recordingMbid || !title || !artist) return [];
        return [
            {
                recordingMbid: recordingMbid.toLocaleLowerCase("en-US"),
                title,
                artist,
                album:
                    String(row.album ?? row.release_name ?? "").trim() || null,
            },
        ];
    });
}

function lastGoodCacheKey(userId: string): string {
    return `recommendations:listenbrainz:last-good:${userId}`;
}

async function beforeDeadline<T>(
    operation: Promise<T>,
    deadline: number,
    onTimeout?: () => void,
): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
        onTimeout?.();
        throw new Error("ListenBrainz recommendation deadline exceeded");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    onTimeout?.();
                    reject(
                        new Error(
                            "ListenBrainz recommendation deadline exceeded",
                        ),
                    );
                }, remaining);
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export class ListenBrainzRecommendationAdapter {
    private readonly circuits = new Map<string, CircuitState>();

    constructor(
        private readonly dependencies: ListenBrainzAdapterDependencies,
    ) {}

    private async fallback(
        userId: string,
        totalDeadline: number,
    ): Promise<RecommendationCandidate[]> {
        const controller = new AbortController();
        try {
            return (
                (await beforeDeadline(
                    this.dependencies.readLastGood(userId, controller.signal),
                    Math.min(
                        totalDeadline,
                        Date.now() + LAST_GOOD_OPERATION_TIMEOUT_MS,
                    ),
                    () => controller.abort(),
                )) ?? []
            );
        } catch {
            return [];
        } finally {
            controller.abort();
        }
    }

    private async persistLastGood(
        userId: string,
        candidates: RecommendationCandidate[],
        totalDeadline: number,
    ): Promise<void> {
        const controller = new AbortController();
        try {
            await beforeDeadline(
                this.dependencies.writeLastGood(
                    userId,
                    candidates,
                    controller.signal,
                ),
                Math.min(
                    totalDeadline,
                    Date.now() + LAST_GOOD_OPERATION_TIMEOUT_MS,
                ),
                () => controller.abort(),
            );
        } catch {
            // Redis is an optimization; never hold the user surface.
        } finally {
            controller.abort();
        }
    }

    async getCandidateBatch(
        userId: string,
        limit: number,
        cursor: number,
    ): Promise<ListenBrainzRecommendationCandidateBatch> {
        const totalDeadline = Date.now() + LISTENBRAINZ_TOTAL_DEADLINE_MS;
        const providerDeadline = totalDeadline - LAST_GOOD_OPERATION_TIMEOUT_MS;
        const now = this.dependencies.now().getTime();
        try {
            const connection = await beforeDeadline(
                this.dependencies.loadConnection(userId),
                providerDeadline,
            );
            if (!connection) return { candidates: [], degradedSources: [] };
            const circuit = this.circuits.get(userId);
            if (circuit && circuit.openUntil > now) {
                return {
                    candidates: await this.fallback(userId, totalDeadline),
                    degradedSources: ["listenbrainz-circuit"],
                };
            }
            const requested = Math.min(
                MAX_CANDIDATES,
                Math.max(limit * 2, limit),
            );
            const mbids = await beforeDeadline(
                this.dependencies.fetchCollaborativeMbids(
                    connection,
                    requested,
                    Math.max(0, cursor * limit),
                ),
                providerDeadline,
            );
            const metadata =
                mbids.length > 0
                    ? await beforeDeadline(
                          this.dependencies.fetchRecordingMetadata(
                              connection,
                              mbids,
                          ),
                          providerDeadline,
                      )
                    : await beforeDeadline(
                          this.dependencies.fetchTagRadioMetadata(
                              connection,
                              requested,
                          ),
                          providerDeadline,
                      );
            const resolved: RecommendationCandidate[] = [];
            let playableResolutionDegraded = false;
            const resolutionController = new AbortController();
            try {
                for (let offset = 0; offset < metadata.length; offset += 3) {
                    const batch = metadata.slice(offset, offset + 3);
                    const matches = await beforeDeadline(
                        Promise.allSettled(
                            batch.map(async (recording, batchIndex) => {
                                const playable =
                                    await limitListenBrainzPlayableResolution(
                                        () => {
                                            if (
                                                resolutionController.signal
                                                    .aborted
                                            ) {
                                                const error = new Error(
                                                    "ListenBrainz playable resolution cancelled",
                                                );
                                                error.name = "AbortError";
                                                throw error;
                                            }
                                            return this.dependencies.resolvePlayable(
                                                userId,
                                                recording,
                                                resolutionController.signal,
                                            );
                                        },
                                    );
                                if (!playable) return null;
                                const candidate: RecommendationCandidate = {
                                    id: `yt:${playable.videoId}`,
                                    canonicalKey: "",
                                    recordingMbid: recording.recordingMbid,
                                    title: playable.title || recording.title,
                                    duration: playable.duration,
                                    artist: {
                                        id: null,
                                        name: recording.artist,
                                    },
                                    album: {
                                        id: null,
                                        title: recording.album || "Single",
                                        coverArt: null,
                                    },
                                    source: "youtube",
                                    provider: {
                                        tidalTrackId: null,
                                        youtubeVideoId: playable.videoId,
                                    },
                                    streamSource: "youtube",
                                    youtubeVideoId: playable.videoId,
                                    candidateSources: [
                                        mbids.length > 0
                                            ? "listenbrainz-cf"
                                            : "listenbrainz-radio",
                                    ],
                                    providerPrior: Math.max(
                                        0.2,
                                        1 -
                                            (offset + batchIndex) /
                                                Math.max(1, metadata.length),
                                    ),
                                };
                                candidate.canonicalKey =
                                    buildCanonicalRecordingKey(candidate);
                                return candidate;
                            }),
                        ),
                        providerDeadline,
                        () => resolutionController.abort(),
                    );
                    for (const match of matches) {
                        if (match.status === "fulfilled" && match.value) {
                            resolved.push(match.value);
                        } else if (match.status === "rejected") {
                            playableResolutionDegraded = true;
                        }
                    }
                    if (resolved.length >= limit) break;
                }
            } finally {
                resolutionController.abort();
            }
            const bounded = resolved.slice(0, limit);
            if (playableResolutionDegraded && bounded.length === 0) {
                throw new Error(
                    "ListenBrainz playable resolution failed for every candidate",
                );
            }
            this.circuits.delete(userId);
            if (bounded.length > 0) {
                await this.persistLastGood(userId, bounded, totalDeadline);
            }
            return {
                candidates: bounded,
                degradedSources: playableResolutionDegraded
                    ? ["listenbrainz-resolve"]
                    : [],
            };
        } catch (error) {
            const previous = this.circuits.get(userId) ?? {
                failures: 0,
                openUntil: 0,
            };
            const failures = previous.failures + 1;
            this.circuits.set(userId, {
                failures,
                openUntil:
                    failures >= CIRCUIT_FAILURE_LIMIT
                        ? now + CIRCUIT_OPEN_MS
                        : 0,
            });
            log.warn(
                "ListenBrainz candidate retrieval degraded to last-good cache",
                { userId, failures },
                error,
            );
            return {
                candidates: await this.fallback(userId, totalDeadline),
                degradedSources: ["listenbrainz"],
            };
        }
    }

    async getCandidates(
        userId: string,
        limit: number,
        cursor: number,
    ): Promise<RecommendationCandidate[]> {
        return (await this.getCandidateBatch(userId, limit, cursor)).candidates;
    }
}

async function loadConnection(
    userId: string,
): Promise<ListenBrainzConnection | null> {
    const [connection, settings] = await Promise.all([
        prisma.scrobbleConnection.findUnique({
            where: { userId_service: { userId, service: "listenbrainz" } },
            select: {
                encryptedCredential: true,
                username: true,
                enabled: true,
            },
        }),
        prisma.userSettings.findUnique({
            where: { userId },
            select: { tasteProfile: true },
        }),
    ]);
    if (
        !connection?.enabled ||
        !connection.encryptedCredential ||
        !connection.username
    ) {
        return null;
    }
    return {
        username: connection.username,
        token: decrypt(connection.encryptedCredential),
        tags: parseTasteTags(settings?.tasteProfile),
    };
}

async function fetchCollaborativeMbids(
    connection: ListenBrainzConnection,
    count: number,
    offset: number,
): Promise<string[]> {
    const response = await axios.get(
        `${LISTENBRAINZ_API}/cf/recommendation/user/${encodeURIComponent(
            connection.username,
        )}/recording`,
        {
            params: { count, offset },
            headers: { Authorization: `Token ${connection.token}` },
            timeout: LISTENBRAINZ_TIMEOUT_MS,
            validateStatus: (status) => status === 204 || status === 200,
        },
    );
    if (response.status === 204) return [];
    const raw = response.data?.payload?.mbids;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item: unknown) => {
        const value =
            typeof item === "string"
                ? item
                : item && typeof item === "object"
                  ? String(
                        (item as Record<string, unknown>).recording_mbid ??
                            (item as Record<string, unknown>).mbid ??
                            "",
                    )
                  : "";
        const normalized = value.trim().toLocaleLowerCase("en-US");
        return normalized ? [normalized] : [];
    });
}

async function fetchRecordingMetadata(
    connection: ListenBrainzConnection,
    recordingMbids: string[],
): Promise<ListenBrainzRecordingMetadata[]> {
    if (recordingMbids.length === 0) return [];
    const response = await axios.post(`${LISTENBRAINZ_API}/player`, null, {
        params: { recording_mbids: recordingMbids.slice(0, 50).join(",") },
        headers: { Authorization: `Token ${connection.token}` },
        timeout: LISTENBRAINZ_TIMEOUT_MS,
    });
    return parseJspfMetadata(response.data);
}

async function fetchTagRadioMetadata(
    connection: ListenBrainzConnection,
    count: number,
): Promise<ListenBrainzRecordingMetadata[]> {
    const tag = connection.tags?.[0];
    if (!tag) return [];
    const response = await axios.get(`${LISTENBRAINZ_API}/lb-radio/tags`, {
        params: { tag, count },
        headers: { Authorization: `Token ${connection.token}` },
        timeout: LISTENBRAINZ_TIMEOUT_MS,
    });
    return parseJspfMetadata(response.data);
}

async function readLastGood(
    userId: string,
    signal?: AbortSignal,
): Promise<RecommendationCandidate[] | null> {
    try {
        const { redisClient } = await import("../../utils/redis");
        if (!redisClient.isReady || signal?.aborted) return null;
        const client = signal
            ? redisClient.withAbortSignal(signal)
            : redisClient;
        const raw = await client.get(lastGoodCacheKey(userId));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.slice(0, MAX_CANDIDATES) : null;
    } catch {
        return null;
    }
}

async function writeLastGood(
    userId: string,
    tracks: RecommendationCandidate[],
    signal?: AbortSignal,
): Promise<void> {
    try {
        const { redisClient } = await import("../../utils/redis");
        if (!redisClient.isReady || signal?.aborted) return;
        const client = signal
            ? redisClient.withAbortSignal(signal)
            : redisClient;
        await client.set(lastGoodCacheKey(userId), JSON.stringify(tracks), {
            EX: LAST_GOOD_TTL_SECONDS,
        });
    } catch {
        // Cache failure must not make the provider adapter unavailable.
    }
}

export const listenBrainzRecommendationAdapter =
    new ListenBrainzRecommendationAdapter({
        loadConnection,
        fetchCollaborativeMbids,
        fetchTagRadioMetadata,
        fetchRecordingMetadata,
        resolvePlayable: (userId, metadata, signal) =>
            ytMusicService.findMatchForTrack(
                userId,
                metadata.artist,
                metadata.title,
                metadata.album ?? undefined,
                undefined,
                undefined,
                { signal, timeoutMs: 5_000, maxRetries: 0 },
            ),
        readLastGood,
        writeLastGood,
        now: () => new Date(),
    });
