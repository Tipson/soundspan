import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { ytMusicService } from "./youtubeMusic";

const MAX_GENRES = 10;
const MAX_ARTISTS = 10;
const MAX_TOTAL_SIGNALS = 16;
const MIN_TOTAL_SIGNALS = 3;
const MAX_SEED_TRACKS = 12;
const PROVIDER_QUERY_LIMIT = 3;
const PROVIDER_TIMEOUT_MS = 5_000;
const PROVIDER_CONCURRENCY = 3;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const log = logger.child("TasteProfile");

const tasteLabelSchema = z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const tasteSeedTrackSchema = z
    .object({
        id: z.string().min(1).max(96),
        videoId: z.string().regex(VIDEO_ID_PATTERN),
        title: z.string().min(1).max(300),
        artist: z.string().min(1).max(300),
        album: z.string().min(1).max(300),
        duration: z.number().int().min(0).max(86_400),
        thumbnailUrl: z.string().url().max(2_048),
        artistId: z.string().max(256).nullable(),
        albumId: z.string().max(256).nullable(),
    })
    .strict();

/** Runtime-validated provider seed persisted inside UserSettings JSON. */
export type TasteSeedTrack = z.infer<typeof tasteSeedTrackSchema>;

const storedTasteProfileSchema = z
    .object({
        genres: z.array(tasteLabelSchema).max(MAX_GENRES),
        artists: z.array(tasteLabelSchema).max(MAX_ARTISTS),
        seedTracks: z.array(tasteSeedTrackSchema).min(1).max(MAX_SEED_TRACKS),
    })
    .strict();

/** Account-scoped taste selections and resolved playable provider identities. */
export type StoredTasteProfile = z.infer<typeof storedTasteProfileSchema>;

/** Minimal persistence row needed by the taste-profile domain service. */
export interface TasteProfilePersistenceState {
    tasteProfile: unknown;
    tasteProfileCompletedAt: Date | null;
    tasteProfileSkippedAt: Date | null;
}

/** Atomic account-scoped state written by completion or skip. */
export interface TasteProfileWrite {
    tasteProfile: StoredTasteProfile | null;
    tasteProfileCompletedAt: Date | null;
    tasteProfileSkippedAt: Date | null;
}

/** Validated profile selection accepted by the domain service. */
export interface TasteProfileSelection {
    genres: string[];
    artists: string[];
}

/** Public state returned by the taste-profile API. */
export interface TasteProfileResult {
    profile: StoredTasteProfile | null;
    completedAt: string | null;
    skippedAt: string | null;
    needsOnboarding: boolean;
}

/** Canonical song metadata used to create a bounded provider seed. */
export interface TasteProfileSearchTrack {
    providerTrackId: string;
    title: string;
    artistName: string;
    albumTitle: string | null;
    durationSec: number | null;
    thumbnailUrl: string | null;
}

/** External dependencies isolated for deterministic profile-domain tests. */
export interface TasteProfileDependencies {
    loadState: (userId: string) => Promise<TasteProfilePersistenceState>;
    hasMeaningfulSignals: (userId: string) => Promise<boolean>;
    saveState: (
        userId: string,
        write: TasteProfileWrite,
    ) => Promise<TasteProfilePersistenceState>;
    searchSongs: (
        userId: string,
        query: string,
        options: { limit: number; timeoutMs: number },
    ) => Promise<TasteProfileSearchTrack[]>;
    now: () => Date;
}

/** Raised when onboarding cannot produce even one playable provider seed. */
export class TasteProfileUnavailableError extends Error {
    constructor() {
        super("No playable taste-profile seeds could be resolved");
        this.name = "TasteProfileUnavailableError";
    }
}

function distinctLabels(values: readonly string[]): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const parsed = tasteLabelSchema.safeParse(value);
        if (!parsed.success) {
            throw new TypeError("Invalid taste profile label");
        }
        const key = parsed.data.toLocaleLowerCase("en-US");
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(parsed.data);
    }
    return normalized;
}

function normalizeSelection(
    selection: TasteProfileSelection,
): TasteProfileSelection {
    const genres = distinctLabels(selection.genres);
    const artists = distinctLabels(selection.artists);
    if (
        genres.length > MAX_GENRES ||
        artists.length > MAX_ARTISTS ||
        genres.length + artists.length > MAX_TOTAL_SIGNALS ||
        genres.length + artists.length < MIN_TOTAL_SIGNALS
    ) {
        throw new TypeError("Invalid taste profile selection count");
    }
    return { genres, artists };
}

/** Parse untrusted persisted JSON without allowing malformed rows into ranking. */
export function parseStoredTasteProfile(
    value: unknown,
): StoredTasteProfile | null {
    const parsed = storedTasteProfileSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function safeIso(value: Date | null): string | null {
    return value instanceof Date && Number.isFinite(value.getTime())
        ? value.toISOString()
        : null;
}

function toResult(
    state: TasteProfilePersistenceState,
    needsOnboarding: boolean,
): TasteProfileResult {
    return {
        profile: parseStoredTasteProfile(state.tasteProfile),
        completedAt: safeIso(state.tasteProfileCompletedAt),
        skippedAt: safeIso(state.tasteProfileSkippedAt),
        needsOnboarding,
    };
}

function toSeedTrack(
    candidate: TasteProfileSearchTrack,
): TasteSeedTrack | null {
    const videoId = candidate.providerTrackId.trim();
    const title = candidate.title.trim();
    const artist = candidate.artistName.trim();
    if (!VIDEO_ID_PATTERN.test(videoId) || !title || !artist) return null;
    const thumbnailUrl =
        candidate.thumbnailUrl?.trim() ||
        `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
    const parsed = tasteSeedTrackSchema.safeParse({
        id: `taste:${videoId}`,
        videoId,
        title,
        artist,
        album: candidate.albumTitle?.trim() || "Single",
        duration:
            typeof candidate.durationSec === "number" &&
            Number.isFinite(candidate.durationSec) &&
            candidate.durationSec >= 0
                ? Math.round(candidate.durationSec)
                : 0,
        thumbnailUrl,
        artistId: null,
        albumId: null,
    });
    return parsed.success ? parsed.data : null;
}

async function withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(
            () => reject(new Error("Taste provider query timed out")),
            timeoutMs,
        );
        timeoutId.unref?.();
    });
    try {
        return await Promise.race([operation, timeout]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

async function mapWithConcurrency<T, R>(
    values: readonly T[],
    concurrency: number,
    mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(values.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < values.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await mapper(values[index], index);
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(concurrency, values.length) }, worker),
    );
    return results;
}

/** Account-scoped onboarding profile orchestration and bounded seed resolution. */
export class TasteProfileService {
    constructor(private readonly dependencies: TasteProfileDependencies) {}

    /** Return the stored profile and whether this account still needs onboarding. */
    async getProfile(userId: string): Promise<TasteProfileResult> {
        if (!userId.trim()) throw new TypeError("A user id is required");
        const state = await this.dependencies.loadState(userId);
        const profile = parseStoredTasteProfile(state.tasteProfile);
        const explicitlyFinished =
            (profile !== null && state.tasteProfileCompletedAt !== null) ||
            state.tasteProfileSkippedAt !== null;
        const hasMeaningfulSignals = explicitlyFinished
            ? false
            : await this.dependencies.hasMeaningfulSignals(userId);
        return toResult(state, !explicitlyFinished && !hasMeaningfulSignals);
    }

    /** Resolve and persist a completed selection without creating synthetic likes. */
    async saveProfile(
        userId: string,
        selection: TasteProfileSelection,
    ): Promise<TasteProfileResult> {
        if (!userId.trim()) throw new TypeError("A user id is required");
        const normalized = normalizeSelection(selection);
        const queries = [
            ...normalized.genres.map((genre) => `${genre} music`),
            ...normalized.artists.map((artist) => `${artist} songs`),
        ];
        const resolved = await mapWithConcurrency(
            queries,
            PROVIDER_CONCURRENCY,
            async (query) => {
                try {
                    const candidates = await withTimeout(
                        this.dependencies.searchSongs(userId, query, {
                            limit: PROVIDER_QUERY_LIMIT,
                            timeoutMs: PROVIDER_TIMEOUT_MS,
                        }),
                        PROVIDER_TIMEOUT_MS,
                    );
                    return (Array.isArray(candidates) ? candidates : [])
                        .slice(0, PROVIDER_QUERY_LIMIT)
                        .map(toSeedTrack)
                        .find(
                            (track): track is TasteSeedTrack => track !== null,
                        );
                } catch (error) {
                    log.warn("Taste seed query failed", { userId }, error);
                    return undefined;
                }
            },
        );
        const seedTracks: TasteSeedTrack[] = [];
        const seen = new Set<string>();
        for (const track of resolved) {
            if (!track || seen.has(track.videoId)) continue;
            seen.add(track.videoId);
            seedTracks.push(track);
            if (seedTracks.length >= MAX_SEED_TRACKS) break;
        }
        if (seedTracks.length === 0) {
            throw new TasteProfileUnavailableError();
        }

        const completedAt = this.dependencies.now();
        const state = await this.dependencies.saveState(userId, {
            tasteProfile: {
                genres: normalized.genres,
                artists: normalized.artists,
                seedTracks,
            },
            tasteProfileCompletedAt: completedAt,
            tasteProfileSkippedAt: null,
        });
        return toResult(state, false);
    }

    /** Persist an account-scoped skip while keeping later editing available. */
    async skipProfile(userId: string): Promise<TasteProfileResult> {
        if (!userId.trim()) throw new TypeError("A user id is required");
        const state = await this.dependencies.saveState(userId, {
            tasteProfile: null,
            tasteProfileCompletedAt: null,
            tasteProfileSkippedAt: this.dependencies.now(),
        });
        return toResult(state, false);
    }
}

async function loadStateFromPrisma(
    userId: string,
): Promise<TasteProfilePersistenceState> {
    const state = await prisma.userSettings.findUnique({
        where: { userId },
        select: {
            tasteProfile: true,
            tasteProfileCompletedAt: true,
            tasteProfileSkippedAt: true,
        },
    });
    return (
        state ?? {
            tasteProfile: null,
            tasteProfileCompletedAt: null,
            tasteProfileSkippedAt: null,
        }
    );
}

async function hasMeaningfulSignalsFromPrisma(
    userId: string,
): Promise<boolean> {
    const [play, remoteLike, playlistItem] = await Promise.all([
        prisma.play.findFirst({
            where: {
                userId,
                AND: [
                    {
                        OR: [
                            { trackYtMusicId: { not: null } },
                            { trackTidalId: { not: null } },
                        ],
                    },
                    {
                        OR: [
                            { outcome: { in: ["meaningful", "completed"] } },
                            { completionRatio: { gte: 0.5 } },
                            { listenedSeconds: { gte: 30 } },
                        ],
                    },
                ],
            },
            select: { id: true },
        }),
        prisma.likedRemoteTrack.findFirst({
            where: {
                userId,
                OR: [
                    { trackYtMusicId: { not: null } },
                    { trackTidalId: { not: null } },
                ],
            },
            select: { id: true },
        }),
        prisma.playlistItem.findFirst({
            where: {
                playlist: { is: { userId } },
                OR: [
                    { trackYtMusicId: { not: null } },
                    { trackTidalId: { not: null } },
                ],
            },
            select: { id: true },
        }),
    ]);
    return play !== null || remoteLike !== null || playlistItem !== null;
}

async function saveStateToPrisma(
    userId: string,
    write: TasteProfileWrite,
): Promise<TasteProfilePersistenceState> {
    const tasteProfile = write.tasteProfile
        ? (write.tasteProfile as Prisma.InputJsonValue)
        : Prisma.DbNull;
    return prisma.userSettings.upsert({
        where: { userId },
        create: {
            userId,
            tasteProfile,
            tasteProfileCompletedAt: write.tasteProfileCompletedAt,
            tasteProfileSkippedAt: write.tasteProfileSkippedAt,
        },
        update: {
            tasteProfile,
            tasteProfileCompletedAt: write.tasteProfileCompletedAt,
            tasteProfileSkippedAt: write.tasteProfileSkippedAt,
        },
        select: {
            tasteProfile: true,
            tasteProfileCompletedAt: true,
            tasteProfileSkippedAt: true,
        },
    });
}

/** Process-wide taste profile service backed by Prisma and YouTube Music. */
export const tasteProfileService = new TasteProfileService({
    loadState: loadStateFromPrisma,
    hasMeaningfulSignals: hasMeaningfulSignalsFromPrisma,
    saveState: saveStateToPrisma,
    searchSongs: async (userId, query, options) => {
        const result = await ytMusicService.searchCanonical(
            userId,
            query,
            "songs",
            options.limit,
            { timeoutMs: options.timeoutMs, maxRetries: 0 },
        );
        return result.results;
    },
    now: () => new Date(),
});
