import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type Bull from "bull";
import type { Prisma } from "@prisma/client";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { sanitizeEnrichmentErrorSummary } from "../../utils/enrichmentErrorSummary";
import { toErrorMessage } from "../../utils/errors";
import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import type { ScheduleRecommendationHotSetInput } from "./engine";
import type { RecommendationCandidate } from "./types";
import {
    canonicalIdentityResolver,
    runCanonicalIdentityTransaction,
} from "./canonicalIdentity";
import { onlineIdentityEnricher } from "./onlineIdentityEnrichment";

const log = logger.child("RemoteAnalysisHotSet");
const SPOOL_DIRECTORY = ".soundspan-analysis-spool";
const MAX_HOT_SET_CANDIDATES = 48;
const MAX_HOT_SET_PER_SIGNAL = 20;
// Admission capacity, not ranking weights: identity-only work cannot fill the
// audio-analysis lane. Both queries together retain the old20-row signal cap.
const MAX_IDENTITY_ONLY_PER_SIGNAL = 4;
const MAX_ANALYSIS_PER_SIGNAL =
    MAX_HOT_SET_PER_SIGNAL - MAX_IDENTITY_ONLY_PER_SIGNAL;
const MAX_REPEAT_SIGNAL_PLAYS = 500;
const MAX_REMOTE_ASSET_BYTES = 64 * 1024 * 1024;
const REMOTE_ASSET_DOWNLOAD_DEADLINE_MS = 15 * 60 * 1_000;
const LEASE_TTL_MS = 2 * 60 * 60 * 1_000;
const RECOVERY_RETRY_MS = 15 * 60 * 1_000;
const BUDGET_RESERVATION_TTL_SECONDS = 2 * 24 * 60 * 60;
const FAILED_ANALYSIS_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const ACTIVE_LEASE_STATUSES = [
    "downloading",
    "downloaded",
    "queued_essentia",
    "processing",
    "expiring",
    "cleanup_failed",
] as const;

class RemoteAnalysisError extends Error {}

function classifyRemoteAnalysisError(error: unknown): {
    errorName: string;
    errorMessage: string;
    errorCode?: string;
    upstreamStatus?: number;
} {
    const record =
        typeof error === "object" && error !== null
            ? (error as Record<string, unknown>)
            : null;
    const response =
        record &&
        typeof record.response === "object" &&
        record.response !== null
            ? (record.response as Record<string, unknown>)
            : null;
    const safeMessage = sanitizeEnrichmentErrorSummary(toErrorMessage(error));
    return {
        errorName: error instanceof Error ? "Error" : "UnknownError",
        errorMessage: safeMessage || "Unknown remote analysis failure",
        ...(typeof record?.code === "string" ? { errorCode: record.code } : {}),
        ...(typeof response?.status === "number"
            ? { upstreamStatus: response.status }
            : {}),
    };
}
const CLAIM_DAILY_BUDGET_SCRIPT = `
local reservation = redis.call("GET", KEYS[1])
if reservation == "allowed" then
    return 1
end
if reservation == "denied" then
    return 0
end

local count = redis.call("INCR", KEYS[2])
if count == 1 then
    redis.call("EXPIRE", KEYS[2], ARGV[2])
end

if count <= tonumber(ARGV[1]) then
    redis.call("SET", KEYS[1], "allowed", "EX", ARGV[2])
    return 1
end

redis.call("SET", KEYS[1], "denied", "EX", ARGV[2])
return 0
`;

export interface RemoteAnalysisJob {
    userId: string;
    canonicalRecordingId: string;
    provider: "youtube";
    providerTrackId: string;
}

interface RemoteAnalysisHotSetDependencies {
    enabled: boolean;
    isAccountEligible?: (userId: string) => Promise<boolean>;
    loadCoveredCanonicalIds: (
        canonicalRecordingIds: string[],
    ) => Promise<ReadonlySet<string>>;
    enqueue: (job: RemoteAnalysisJob, jobId: string) => Promise<void>;
    loadAccountCandidates?: (
        userId: string,
    ) => Promise<RecommendationCandidate[]>;
    enrichIdentities?: (
        userId: string,
        candidates: RecommendationCandidate[],
    ) => Promise<void>;
    resolveCanonicalIdentities?: (
        candidates: RecommendationCandidate[],
    ) => Promise<RecommendationCandidate[]>;
}

function remoteIdentity(candidate: RecommendationCandidate): {
    provider: "youtube";
    providerTrackId: string;
} | null {
    if (candidate.provider.youtubeVideoId) {
        return {
            provider: "youtube",
            providerTrackId: candidate.provider.youtubeVideoId,
        };
    }
    return null;
}

function selectFairHotSetCandidates(
    batches: readonly (readonly RecommendationCandidate[])[],
): RecommendationCandidate[] {
    const unique = new Map<string, RecommendationCandidate>();
    const queues = batches.map((batch) => {
        const keys = new Set<string>();
        for (const candidate of batch) {
            const key = candidate.canonicalRecordingId
                ? `canonical:${candidate.canonicalRecordingId}`
                : `${candidate.source}:${candidate.provider.youtubeVideoId ?? candidate.provider.tidalTrackId ?? candidate.id}`;
            if (keys.size < MAX_HOT_SET_CANDIDATES) keys.add(key);
            const existing = unique.get(key);
            if (!existing && keys.has(key))
                unique.set(key, {
                    ...candidate,
                    candidateSources: [...candidate.candidateSources],
                });
            else if (existing)
                existing.candidateSources = Array.from(
                    new Set([
                        ...existing.candidateSources,
                        ...candidate.candidateSources,
                    ]),
                );
        }
        return [...keys];
    });
    const selected = new Set<string>();
    const offsets = queues.map(() => 0);
    while (
        selected.size < MAX_HOT_SET_CANDIDATES &&
        queues.some((queue, index) => offsets[index] < queue.length)
    ) {
        for (let index = 0; index < queues.length; index += 1) {
            while (offsets[index] < queues[index].length) {
                const id = queues[index][offsets[index]++];
                if (selected.has(id)) continue;
                selected.add(id);
                break;
            }
            if (selected.size >= MAX_HOT_SET_CANDIDATES) break;
        }
    }
    return [...selected].map((id) => unique.get(id)!);
}

/** Bounded, global canonical admission; no live recommendation waits on it. */
export class RemoteAnalysisHotSetScheduler {
    constructor(
        private readonly dependencies: RemoteAnalysisHotSetDependencies,
    ) {}

    async schedule(input: ScheduleRecommendationHotSetInput): Promise<void> {
        if (!this.dependencies.enabled) return;
        if (
            this.dependencies.isAccountEligible &&
            !(await this.dependencies.isAccountEligible(input.userId))
        )
            return;
        let accountCandidates: RecommendationCandidate[] = [];
        if (this.dependencies.loadAccountCandidates) {
            try {
                accountCandidates =
                    await this.dependencies.loadAccountCandidates(input.userId);
            } catch (error) {
                log.warn("Account hot-set loading failed", {
                    userId: input.userId,
                    error,
                });
            }
        }
        let prioritizedCandidates = selectFairHotSetCandidates([
            input.candidates,
            accountCandidates,
        ]);
        try {
            await this.dependencies.enrichIdentities?.(
                input.userId,
                prioritizedCandidates,
            );
        } catch (error) {
            log.warn("Hot-set identity enrichment degraded", {
                userId: input.userId,
                error,
            });
        }
        try {
            prioritizedCandidates =
                (await this.dependencies.resolveCanonicalIdentities?.(
                    prioritizedCandidates,
                )) ?? prioritizedCandidates;
        } catch (error) {
            log.warn("Hot-set canonical identity refresh degraded", {
                userId: input.userId,
                error,
            });
        }
        const unique = new Map<
            string,
            {
                candidate: RecommendationCandidate;
                identity: NonNullable<ReturnType<typeof remoteIdentity>>;
            }
        >();
        for (const candidate of prioritizedCandidates) {
            const canonicalRecordingId = candidate.canonicalRecordingId;
            const identity = remoteIdentity(candidate);
            if (!canonicalRecordingId || !identity) continue;
            if (!unique.has(canonicalRecordingId)) {
                unique.set(canonicalRecordingId, { candidate, identity });
            }
            if (unique.size >= MAX_HOT_SET_CANDIDATES) break;
        }
        if (unique.size === 0) return;
        const covered = await this.dependencies.loadCoveredCanonicalIds([
            ...unique.keys(),
        ]);
        await Promise.all(
            [...unique.entries()].flatMap(
                ([canonicalRecordingId, { identity }]) =>
                    covered.has(canonicalRecordingId)
                        ? []
                        : [
                              this.dependencies.enqueue(
                                  {
                                      userId: input.userId,
                                      canonicalRecordingId,
                                      ...identity,
                                  },
                                  `remote-analysis:${canonicalRecordingId}`,
                              ),
                          ],
            ),
        );
    }
}

type HotSetMapping = {
    canonicalRecordingId: string | null;
    canonicalRecording?: {
        recordingMbid: string | null;
        isrc: string | null;
    } | null;
    trackYtMusic: {
        id: string;
        videoId: string;
        title: string;
        artist: string;
        album: string;
        duration: number;
        thumbnailUrl: string | null;
    } | null;
};

function hotSetCandidate(
    mapping: HotSetMapping,
    signal: string,
): RecommendationCandidate | null {
    const canonicalRecordingId = mapping.canonicalRecordingId;
    if (!canonicalRecordingId) return null;
    if (mapping.trackYtMusic) {
        const track = mapping.trackYtMusic;
        return {
            id: `yt:${track.videoId}`,
            canonicalKey: `canonical:${canonicalRecordingId}`,
            canonicalRecordingId,
            recordingMbid: mapping.canonicalRecording?.recordingMbid,
            isrc: mapping.canonicalRecording?.isrc,
            title: track.title,
            duration: track.duration,
            artist: { id: null, name: track.artist },
            album: {
                id: null,
                title: track.album,
                coverArt: track.thumbnailUrl,
            },
            source: "youtube",
            provider: { tidalTrackId: null, youtubeVideoId: track.videoId },
            streamSource: "youtube",
            youtubeVideoId: track.videoId,
            candidateSources: [signal],
            providerPrior: 1,
        };
    }
    return null;
}

/**
 * Load a bounded online-first analysis set from durable account signals.
 * Each signal contributes one unseen canonical per round, in likes/seed-first
 * order. Exhausted or duplicate-only signals yield their slots to the others.
 */
export async function loadAccountHotSetCandidates(
    userId: string,
): Promise<RecommendationCandidate[]> {
    const signalQueries: Array<{
        source: string;
        where: Prisma.TrackMappingWhereInput;
    }> = [
        {
            source: "hot-liked",
            where: {
                trackYtMusic: { is: { likedBy: { some: { userId } } } },
            },
        },
        {
            source: "hot-wave-seed",
            where: {
                trackYtMusic: {
                    is: {
                        plays: {
                            some: { userId, playContext: "wave" },
                        },
                    },
                },
            },
        },
        {
            source: "hot-completed",
            where: {
                trackYtMusic: {
                    is: {
                        plays: {
                            some: {
                                userId,
                                OR: [
                                    { outcome: "completed" },
                                    { completionRatio: { gte: 0.85 } },
                                ],
                            },
                        },
                    },
                },
            },
        },
        {
            source: "hot-playlist",
            where: {
                trackYtMusic: {
                    is: {
                        playlistItems: {
                            some: { playlist: { userId } },
                        },
                    },
                },
            },
        },
    ];
    const batches = await Promise.all(
        signalQueries.map(async ({ source, where }) => ({
            source,
            rows: await loadHotSetWorkMappings(where),
        })),
    );
    const repeatedRows = await loadRepeatedHotSetMappings(userId);
    batches.push({ source: "hot-repeated", rows: repeatedRows });
    return selectFairHotSetCandidates(
        batches.map((batch) =>
            batch.rows.flatMap((row) => {
                const candidate = hotSetCandidate(row, batch.source);
                return candidate ? [candidate] : [];
            }),
        ),
    );
}

const completedAnalysisWhere: Prisma.CanonicalRecordingWhereInput = {
    analysisStatus: "completed",
    embeddingStatus: "completed",
    embeddings: {
        some: {
            space: {
                status: { in: ["active", "migrating"] },
                cleaningAt: null,
            },
        },
    },
};

function temporarilyUnavailableAnalysisWhere(
    now: Date,
    includeFailedCooldown = true,
): Prisma.CanonicalRecordingWhereInput[] {
    const cooldownStart = new Date(now.getTime() - FAILED_ANALYSIS_COOLDOWN_MS);
    return [
        ...(includeFailedCooldown
            ? [
                  {
                      analysisStatus: "failed",
                      updatedAt: { gte: cooldownStart },
                  },
                  {
                      embeddingStatus: "failed",
                      embeddingAnalyzedAt: { gte: cooldownStart },
                  },
              ]
            : []),
        {
            analysisLeases: {
                some: {
                    status: { in: [...ACTIVE_LEASE_STATUSES] },
                    expiresAt: { gt: now },
                },
            },
        },
    ];
}

async function loadHotSetWorkMappings(
    where: Prisma.TrackMappingWhereInput,
): Promise<HotSetMapping[]> {
    const mappingWhere: Prisma.TrackMappingWhereInput = {
        AND: [{ stale: false, trackYtMusic: { isNot: null } }, where],
    };
    const query = async (
        work: Prisma.CanonicalRecordingWhereInput,
        take: number,
    ): Promise<HotSetMapping[]> => {
        // Take unique canonical rows, not provider aliases. Root and nested
        // filters are identical so a different account's newer mapping cannot
        // become this signal's representative. Work order is stable canonical
        // creation time/id; the representative is the newest eligible mapping.
        const rows = await prisma.canonicalRecording.findMany({
            where: {
                AND: [
                    {
                        mergedIntoId: null,
                        identitySource: { not: "identity-merged" },
                    },
                    work,
                    { mappings: { some: mappingWhere } },
                ],
            },
            orderBy: [{ createdAt: "desc" }, { id: "asc" }],
            take,
            select: {
                id: true,
                recordingMbid: true,
                isrc: true,
                mappings: {
                    where: mappingWhere,
                    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
                    take: 1,
                    select: {
                        trackYtMusic: {
                            select: {
                                id: true,
                                videoId: true,
                                title: true,
                                artist: true,
                                album: true,
                                duration: true,
                                thumbnailUrl: true,
                            },
                        },
                    },
                },
            },
        });
        return rows.map((row) => ({
            canonicalRecordingId: row.id,
            canonicalRecording: {
                recordingMbid: row.recordingMbid,
                isrc: row.isrc,
            },
            trackYtMusic: row.mappings[0]?.trackYtMusic ?? null,
        }));
    };
    const [analysis, identity] = await Promise.all([
        query(
            {
                NOT: {
                    OR: [
                        completedAnalysisWhere,
                        ...temporarilyUnavailableAnalysisWhere(new Date()),
                    ],
                },
            },
            MAX_ANALYSIS_PER_SIGNAL,
        ),
        query(
            {
                AND: [
                    completedAnalysisWhere,
                    { OR: [{ recordingMbid: null }, { recordingMbid: "" }] },
                    { OR: [{ isrc: null }, { isrc: "" }] },
                ],
            },
            MAX_IDENTITY_ONLY_PER_SIGNAL,
        ),
    ]);
    // Interleave the16/4 lanes so a full48-canonical account set also retains
    // some identity work, instead of trimming every signal's identity tail.
    const rows: HotSetMapping[] = [];
    for (let index = 0; index < MAX_IDENTITY_ONLY_PER_SIGNAL; index += 1) {
        rows.push(...analysis.slice(index * 4, (index + 1) * 4));
        if (identity[index]) rows.push(identity[index]);
    }
    return rows;
}

async function loadRepeatedHotSetMappings(
    userId: string,
): Promise<HotSetMapping[]> {
    const plays = await prisma.play.findMany({
        where: {
            userId,
            trackYtMusicId: { not: null },
        },
        orderBy: { playedAt: "desc" },
        take: MAX_REPEAT_SIGNAL_PLAYS,
        select: { trackYtMusicId: true },
    });
    const counts = new Map<string, number>();
    for (const play of plays) {
        const identity = play.trackYtMusicId
            ? `youtube:${play.trackYtMusicId}`
            : null;
        if (identity) counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
    const repeated = [...counts.entries()]
        .filter(([, count]) => count >= 2)
        .sort((left, right) => right[1] - left[1])
        .map(([identity]) => identity);
    const youtubeIds = repeated
        .filter((identity) => identity.startsWith("youtube:"))
        .map((identity) => identity.slice("youtube:".length));
    if (youtubeIds.length === 0) return [];
    return loadHotSetWorkMappings({ trackYtMusicId: { in: youtubeIds } });
}

/** Resolve only hidden-spool references; never accepts arbitrary music paths. */
export function resolveAnalysisSpoolPath(
    musicPath: string,
    spoolRef: string,
): string {
    const normalizedRef = spoolRef.replace(/\\/g, "/");
    if (
        path.isAbsolute(spoolRef) ||
        !normalizedRef.startsWith(`${SPOOL_DIRECTORY}/`) ||
        normalizedRef.includes("../") ||
        normalizedRef.includes("/..")
    ) {
        throw new TypeError("Invalid analysis spool reference");
    }
    const root = path.resolve(musicPath, SPOOL_DIRECTORY);
    const resolved = path.resolve(musicPath, ...normalizedRef.split("/"));
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new TypeError("Invalid analysis spool reference");
    }
    return resolved;
}

class ByteLimitTransform extends Transform {
    private received = 0;

    override _transform(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null, data?: Buffer) => void,
    ): void {
        this.received += chunk.length;
        if (this.received > MAX_REMOTE_ASSET_BYTES) {
            callback(new RangeError("Remote analysis asset exceeds 64 MiB"));
            return;
        }
        callback(null, chunk);
    }
}

async function streamRemoteAsset(
    job: RemoteAnalysisJob,
    destination: string,
): Promise<void> {
    const controller = new AbortController();
    const deadlineError = new RemoteAnalysisError(
        "Remote analysis asset download deadline exceeded",
    );
    let responseStream: Readable | undefined;
    const timer = setTimeout(() => {
        controller.abort(deadlineError);
        responseStream?.destroy(deadlineError);
    }, REMOTE_ASSET_DOWNLOAD_DEADLINE_MS);
    timer.unref?.();
    try {
        const requestOptions = {
            signal: controller.signal,
            timeoutMs: REMOTE_ASSET_DOWNLOAD_DEADLINE_MS,
            purpose: "analysis" as const,
        };
        const response = await (
            await import("../youtubeMusic")
        ).ytMusicService.getStreamProxy(
            "__public__",
            job.providerTrackId,
            "medium",
            undefined,
            requestOptions,
        );
        responseStream = response.data as Readable;
        if (controller.signal.aborted) {
            responseStream.destroy(deadlineError);
            throw deadlineError;
        }
        await pipeline(
            responseStream,
            new ByteLimitTransform(),
            createWriteStream(destination, { flags: "wx" }),
            { signal: controller.signal },
        );
    } catch (error) {
        if (controller.signal.aborted) throw deadlineError;
        throw error;
    } finally {
        clearTimeout(timer);
        if (controller.signal.aborted && !responseStream?.destroyed) {
            responseStream?.destroy(deadlineError);
        }
    }
}

function vectorText(embedding: readonly number[]): string {
    if (
        embedding.length === 0 ||
        embedding.some((value) => !Number.isFinite(value))
    ) {
        throw new TypeError("Canonical embedding contains invalid values");
    }
    return `[${embedding.join(",")}]`;
}

async function upsertCanonicalEmbedding(
    canonicalRecordingId: string,
    embedding: readonly number[],
    spaceId: string,
): Promise<void> {
    const serialized = vectorText(embedding);
    await prisma.$transaction(async (transaction) => {
        const rows = await transaction.$queryRaw<Array<{ dim: number }>>`
            SELECT dim
            FROM embedding_spaces
            WHERE id = ${spaceId}
              AND status IN ('active', 'migrating')
              AND cleaning_at IS NULL
            FOR SHARE
        `;
        if (rows[0]?.dim !== embedding.length) {
            throw new RemoteAnalysisError(
                "Canonical embedding space dimension mismatch",
            );
        }
        const written = await transaction.$executeRaw`
            INSERT INTO canonical_recording_embeddings
                (canonical_recording_id, space_id, embedding, analyzed_at)
            VALUES (${canonicalRecordingId}, ${spaceId}, ${serialized}::vector, NOW())
            ON CONFLICT (canonical_recording_id, space_id) DO UPDATE SET
                embedding = EXCLUDED.embedding,
                analyzed_at = EXCLUDED.analyzed_at
        `;
        if (written !== 1) {
            throw new RemoteAnalysisError(
                "Canonical embedding upsert was incomplete",
            );
        }
        await transaction.embeddingSpace.updateMany({
            where: {
                id: spaceId,
                status: { in: ["active", "migrating"] },
                cleaningAt: null,
                hadVectors: false,
            },
            data: { hadVectors: true },
        });
        await transaction.canonicalRecording.update({
            where: { id: canonicalRecordingId },
            data: {
                embeddingStatus: "completed",
                embeddingVersion: spaceId,
                embeddingAnalyzedAt: new Date(),
                embeddingError: null,
            },
        });
    });
}

/** Identify the partial-unique race without coupling callers to Prisma classes. */
export function isRemoteAnalysisLeaseConflict(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "P2002"
    );
}

function utcBudgetDate(now: Date): string {
    return now.toISOString().slice(0, 10);
}

export async function claimRemoteAnalysisDailyBudget(
    canonicalRecordingId: string,
    now: Date,
): Promise<boolean> {
    const day = utcBudgetDate(now);
    const reservationKey = `recommendation:remote-analysis:reservation:${day}:${canonicalRecordingId}`;
    const budgetKey = `recommendation:remote-analysis:budget:${day}`;
    const result = await redisClient.eval(CLAIM_DAILY_BUDGET_SCRIPT, {
        keys: [reservationKey, budgetKey],
        arguments: [
            String(config.recommendations?.remoteAnalysisDailyBudget ?? 100),
            String(BUDGET_RESERVATION_TTL_SECONDS),
        ],
    });
    return Number(result) === 1;
}

/** Load canonical rows blocked by completion/in-flight work and optional retry cooldown. */
export async function loadRemoteAnalysisCoveredCanonicalIds(
    canonicalRecordingIds: string[],
    includeFailedCooldown = true,
): Promise<Set<string>> {
    const now = new Date();
    const rows = await prisma.canonicalRecording.findMany({
        where: {
            id: { in: canonicalRecordingIds },
            OR: [
                { mergedIntoId: { not: null } },
                { identitySource: "identity-merged" },
                {
                    AND: [
                        { analysisStatus: "completed" },
                        { embeddingStatus: "completed" },
                        {
                            embeddings: {
                                some: {
                                    space: {
                                        status: {
                                            in: ["active", "migrating"],
                                        },
                                        cleaningAt: null,
                                    },
                                },
                            },
                        },
                    ],
                },
                ...temporarilyUnavailableAnalysisWhere(
                    now,
                    includeFailedCooldown,
                ),
            ],
        },
        select: { id: true },
    });
    return new Set(rows.map(({ id }) => id));
}

async function enqueueRemoteAnalysis(
    job: RemoteAnalysisJob,
    jobId: string,
): Promise<void> {
    const { remoteAnalysisQueue } = await import("../../workers/queues");
    const existing = await remoteAnalysisQueue.getJob(jobId);
    if (existing) return;
    await remoteAnalysisQueue.add("analyze", job, { jobId });
}

export const remoteAnalysisHotSetScheduler = new RemoteAnalysisHotSetScheduler({
    enabled:
        (config.recommendations?.remoteAnalysisEnabled ?? false) &&
        config.features.audioAnalysis,
    loadCoveredCanonicalIds: loadRemoteAnalysisCoveredCanonicalIds,
    isAccountEligible: async (userId) => {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { isTestAccount: true },
        });
        return user?.isTestAccount === false;
    },
    enqueue: enqueueRemoteAnalysis,
    loadAccountCandidates: loadAccountHotSetCandidates,
    enrichIdentities: (userId, candidates) =>
        onlineIdentityEnricher.enrich(userId, candidates),
    resolveCanonicalIdentities: (candidates) =>
        Promise.all(
            candidates.map(async (candidate) => {
                try {
                    const canonical =
                        await canonicalIdentityResolver.resolve(candidate);
                    return {
                        ...candidate,
                        canonicalRecordingId: canonical.id,
                        canonicalKey: canonical.canonicalKey,
                    };
                } catch (error) {
                    log.warn("Hot-set canonical identity refresh failed", {
                        candidateId: candidate.id,
                        error,
                    });
                    return candidate;
                }
            }),
        ),
});

async function removeSpoolFile(spoolRef: string): Promise<void> {
    const absolutePath = resolveAnalysisSpoolPath(
        config.music.musicPath,
        spoolRef,
    );
    await rm(absolutePath, { force: true });
}

/** Bull processor: bounded download, shared DCLAP, then Essentia hand-off. */
export async function processRemoteAnalysis(
    bullJob: Bull.Job<RemoteAnalysisJob>,
): Promise<{ status: string }> {
    if (
        !(config.recommendations?.remoteAnalysisEnabled ?? false) ||
        !config.features.audioAnalysis
    ) {
        return { status: "disabled" };
    }
    const job = bullJob.data;
    if (
        !job?.userId ||
        !job.canonicalRecordingId ||
        job.provider !== "youtube" ||
        !job.providerTrackId
    ) {
        throw new TypeError("Invalid remote analysis job");
    }
    const analyzed = await loadRemoteAnalysisCoveredCanonicalIds(
        [job.canonicalRecordingId],
        false,
    );
    if (analyzed.has(job.canonicalRecordingId)) {
        return { status: "already-analyzed" };
    }
    const canonicalState = await prisma.canonicalRecording.findUniqueOrThrow({
        where: { id: job.canonicalRecordingId },
        select: {
            analysisStatus: true,
            embeddingStatus: true,
            embeddings: {
                where: {
                    space: {
                        status: { in: ["active", "migrating"] },
                        cleaningAt: null,
                    },
                },
                select: { spaceId: true },
                take: 1,
            },
        },
    });
    const needsEssentia = canonicalState.analysisStatus !== "completed";
    const needsEmbedding =
        canonicalState.embeddingStatus !== "completed" ||
        canonicalState.embeddings.length === 0;
    const now = new Date();
    if (
        !(await claimRemoteAnalysisDailyBudget(job.canonicalRecordingId, now))
    ) {
        return { status: "daily-budget-exhausted" };
    }

    const spoolRef = `${SPOOL_DIRECTORY}/${randomUUID()}.audio`;
    const spoolPath = resolveAnalysisSpoolPath(
        config.music.musicPath,
        spoolRef,
    );
    await mkdir(path.dirname(spoolPath), { recursive: true });
    let lease: { id: string };
    try {
        const admitted = await runCanonicalIdentityTransaction(
            async (transaction) => {
                const canonical =
                    await transaction.canonicalRecording.findUnique({
                        where: { id: job.canonicalRecordingId },
                        select: {
                            mergedIntoId: true,
                            identitySource: true,
                        },
                    });
                if (
                    !canonical ||
                    canonical.mergedIntoId ||
                    canonical.identitySource === "identity-merged"
                ) {
                    return null;
                }
                return transaction.analysisAssetLease.create({
                    data: {
                        canonicalRecordingId: job.canonicalRecordingId,
                        provider: job.provider,
                        providerTrackId: job.providerTrackId,
                        spoolRef,
                        status: "downloading",
                        expiresAt: new Date(now.getTime() + LEASE_TTL_MS),
                    },
                    select: { id: true },
                });
            },
        );
        if (!admitted) return { status: "canonical-merged" };
        lease = admitted;
    } catch (error) {
        if (isRemoteAnalysisLeaseConflict(error)) {
            return { status: "already-in-flight" };
        }
        throw error;
    }
    let handedOff = false;
    let embeddingSettled = !needsEmbedding;
    let stage = "mark-processing";
    try {
        await prisma.canonicalRecording.update({
            where: { id: job.canonicalRecordingId },
            data: {
                ...(needsEssentia
                    ? { analysisStatus: "processing", analysisError: null }
                    : {}),
                ...(needsEmbedding
                    ? {
                          embeddingStatus: "processing",
                          embeddingError: null,
                      }
                    : {}),
            },
        });
        stage = "download";
        await streamRemoteAsset(job, spoolPath);
        stage = "mark-downloaded";
        await prisma.analysisAssetLease.update({
            where: { id: lease.id },
            data: { status: "downloaded" },
        });

        let dclapError: string | null = null;
        if (needsEmbedding) {
            stage = "dclap";
            try {
                const [
                    { embedAudio, fetchProviderSpace },
                    { resolveProviderEmbeddingSpace },
                ] = await Promise.all([
                    import("../vibeProvider"),
                    import("../embeddingSpaces"),
                ]);
                const providerSpace = await fetchProviderSpace();
                const resolution =
                    await resolveProviderEmbeddingSpace(providerSpace);
                const embedding = await embedAudio(spoolRef, resolution.space);
                await upsertCanonicalEmbedding(
                    job.canonicalRecordingId,
                    embedding,
                    resolution.space.id,
                );
                embeddingSettled = true;
            } catch (error) {
                dclapError = "DCLAP embedding analysis failed";
                embeddingSettled = true;
                await prisma.canonicalRecording.update({
                    where: { id: job.canonicalRecordingId },
                    data: {
                        embeddingStatus: "failed",
                        embeddingAnalyzedAt: new Date(),
                        embeddingError: dclapError,
                    },
                });
                log.warn("Remote DCLAP analysis degraded", {
                    canonicalRecordingId: job.canonicalRecordingId,
                    error,
                });
            }
        }

        if (!needsEssentia) {
            if (dclapError) throw new RemoteAnalysisError(dclapError);
            await prisma.analysisAssetLease.update({
                where: { id: lease.id },
                data: { status: "completed", error: null },
            });
            return { status: "embedding-completed" };
        }

        stage = "essentia-handoff";
        // The lease row itself is the durable hand-off. The analyzer polls and
        // atomically claims queued_essentia rows, so rolling deploys cannot let
        // an older analyzer destructively pop an unknown Redis payload.
        await prisma.$transaction([
            prisma.analysisAssetLease.update({
                where: { id: lease.id },
                data: {
                    status: "queued_essentia",
                    expiresAt: new Date(Date.now() + LEASE_TTL_MS),
                    error: dclapError,
                },
            }),
            prisma.canonicalRecording.update({
                where: { id: job.canonicalRecordingId },
                data: {
                    analysisStatus: "processing",
                    analysisError: null,
                },
            }),
        ]);
        handedOff = true;
        return {
            status: dclapError ? "queued-essentia-dclap-degraded" : "queued",
        };
    } catch (error) {
        log.warn("Remote analysis processing failed", {
            canonicalRecordingId: job.canonicalRecordingId,
            provider: job.provider,
            stage,
            ...classifyRemoteAnalysisError(error),
        });
        const message = "Remote analysis failed";
        const terminalUpdates: Promise<unknown>[] = [
            prisma.analysisAssetLease.update({
                where: { id: lease.id },
                data: { status: "failed", error: message },
            }),
        ];
        if (needsEssentia || (needsEmbedding && !embeddingSettled)) {
            terminalUpdates.push(
                prisma.canonicalRecording.update({
                    where: { id: job.canonicalRecordingId },
                    data: {
                        ...(needsEssentia
                            ? {
                                  analysisStatus: "failed",
                                  analysisError: message,
                              }
                            : {}),
                        ...(needsEmbedding && !embeddingSettled
                            ? {
                                  embeddingStatus: "failed",
                                  embeddingAnalyzedAt: new Date(),
                                  embeddingError: message,
                              }
                            : {}),
                    },
                }),
            );
        }
        await Promise.allSettled(terminalUpdates);
        throw error;
    } finally {
        if (!handedOff) {
            try {
                await removeSpoolFile(spoolRef);
            } catch (error) {
                log.warn("Failed to remove terminal remote-analysis asset", {
                    spoolRef,
                    error,
                });
                await prisma.analysisAssetLease
                    .update({
                        where: { id: lease.id },
                        data: {
                            status: "cleanup_failed",
                            expiresAt: new Date(Date.now() + RECOVERY_RETRY_MS),
                            error: "Terminal asset cleanup failed",
                        },
                    })
                    .catch((leaseError) => {
                        log.warn(
                            "Failed to persist terminal asset cleanup state",
                            { leaseId: lease.id, leaseError },
                        );
                    });
            }
        }
    }
}

/** TTL recovery removes only expired files created by this subsystem. */
export async function recoverExpiredRemoteAnalysisAssets(): Promise<number> {
    const now = new Date();
    const expired = await prisma.analysisAssetLease.findMany({
        where: {
            expiresAt: { lt: now },
            status: {
                notIn: ["completed", "expired", "expiring"],
            },
        },
        take: 200,
        select: { id: true, spoolRef: true, canonicalRecordingId: true },
    });
    let recovered = 0;
    for (const lease of expired) {
        const claim = await prisma.analysisAssetLease.updateMany({
            where: {
                id: lease.id,
                expiresAt: { lt: now },
                status: {
                    notIn: ["completed", "expired", "expiring"],
                },
            },
            data: { status: "expiring" },
        });
        if (claim.count === 0) continue;
        try {
            await removeSpoolFile(lease.spoolRef);
        } catch (error) {
            log.warn("Failed to remove expired remote-analysis asset", {
                leaseId: lease.id,
                error,
            });
            await prisma.analysisAssetLease.update({
                where: { id: lease.id },
                data: {
                    status: "cleanup_failed",
                    expiresAt: new Date(Date.now() + RECOVERY_RETRY_MS),
                    error: "Expired asset cleanup failed",
                },
            });
            continue;
        }
        await prisma.$transaction([
            prisma.analysisAssetLease.update({
                where: { id: lease.id },
                data: { status: "expired", error: "Lease expired" },
            }),
            prisma.canonicalRecording.updateMany({
                where: {
                    id: lease.canonicalRecordingId,
                    analysisStatus: "processing",
                    analysisLeases: {
                        none: {
                            status: { in: [...ACTIVE_LEASE_STATUSES] },
                            expiresAt: { gt: now },
                        },
                    },
                },
                data: {
                    analysisStatus: "pending",
                    analysisError: "Remote analysis lease expired",
                },
            }),
        ]);
        recovered += 1;
    }
    return recovered;
}
