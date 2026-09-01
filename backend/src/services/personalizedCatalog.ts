import type { UnifiedTrackYtMusicRecord } from "./unifiedTrackResponse";
import { normalizeYtMusicTrack } from "./unifiedTrackResponse";
import {
    ytMusicService,
    type YtMusicRadioQueue,
    type YtMusicRadioTrack,
} from "./youtubeMusic";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { parseStoredTasteProfile } from "./tasteProfile";
import { listenBrainzRecommendationAdapter } from "./recommendations/listenBrainzAdapter";

const SIGNAL_READ_LIMIT = 100;
const MAX_RADIO_SEEDS = 3;
const MAX_HOME_SHELF_LIMIT = 25;
const MIN_RADIO_RESULT_LIMIT = 12;
const MAX_RADIO_RESULT_LIMIT = 50;
const MAX_CONTINUATION_CURSOR = 1_000_000;
const MAX_CONTINUATION_EXCLUSIONS = 80;
const MAX_DISCOVERY_CANDIDATES = 100;
const log = logger.child("PersonalizedCatalog");

/** Wave policies exposed by the personalized catalog endpoint. */
export type PersonalizedWaveMode = "for-you" | "new" | "familiar";

/** Independent mood or listening-context filter applied to a Wave policy. */
export type PersonalizedWaveMood =
    | "calm"
    | "energetic"
    | "focus"
    | "workout"
    | "favorites"
    | "forgotten";

const SCENARIO_SEARCH_QUERY: Partial<Record<PersonalizedWaveMood, string>> = {
    calm: "calm relaxing music",
    energetic: "energetic upbeat music",
    focus: "focus concentration music",
    workout: "workout energy music",
};

/** Final client-observed playback outcomes used as taste signals. */
export type PersonalizedPlaybackOutcome =
    | "meaningful"
    | "completed"
    | "skipped"
    | "failed"
    | null;

const YOUTUBE_TRACK_SELECT = {
    id: true,
    videoId: true,
    title: true,
    artist: true,
    album: true,
    duration: true,
    thumbnailUrl: true,
    artistId: true,
    albumId: true,
} as const;

/** Remote-only user signals consumed by the personalized catalog engine. */
export interface PersonalizedCatalogSignals {
    recentPlays: UnifiedTrackYtMusicRecord[];
    likedTracks: UnifiedTrackYtMusicRecord[];
    playlistTracks: UnifiedTrackYtMusicRecord[];
    tasteSeedTracks?: UnifiedTrackYtMusicRecord[];
    dislikedEntityIds: string[];
    playbackSignals?: PersonalizedPlaybackSignal[];
}

/** One persisted playback observation joined to its playable YT identity. */
export interface PersonalizedPlaybackSignal {
    track: UnifiedTrackYtMusicRecord;
    listenedSeconds: number | null;
    completionRatio: number | null;
    outcome: PersonalizedPlaybackOutcome;
    playedAt: Date | null;
    waveMode: PersonalizedWaveMode | null;
}

/** Dependencies kept behind the personalized catalog module boundary. */
export interface PersonalizedCatalogDependencies {
    loadSignals: (userId: string) => Promise<PersonalizedCatalogSignals>;
    loadDislikedEntityIds: (
        userId: string,
        canonicalEntityIds: string[],
    ) => Promise<string[]>;
    getRadio: (
        seedVideoId: string,
        limit: number,
    ) => Promise<YtMusicRadioQueue>;
    getListenBrainzCandidates: (
        userId: string,
        limit: number,
        cursor: number,
    ) => Promise<
        UnifiedTrackYtMusicRecord[] | PersonalizedExternalCandidateBatch
    >;
    getScenarioCandidates: (
        userId: string,
        mood: PersonalizedWaveMood,
        limit: number,
    ) => Promise<unknown[]>;
}

export interface PersonalizedExternalCandidateBatch {
    candidates: UnifiedTrackYtMusicRecord[];
    degradedSources: string[];
}

/** Bounded continuation context supplied by one provider-radio session. */
export interface PersonalizedCatalogOptions {
    cursor?: number;
    excludeVideoIds?: readonly string[];
    mode?: PersonalizedWaveMode;
    mood?: PersonalizedWaveMood;
}

/** Playable YouTube response contract shared by all personalized shelves. */
export interface PersonalizedTrack {
    id: string;
    title: string;
    duration: number;
    trackNo: null;
    artist: {
        id: string | null;
        name: string;
    };
    album: {
        id: string | null;
        title: string;
        coverArt: string;
        artist: {
            id: string | null;
            name: string;
        };
    };
    source: "youtube";
    streamSource: "youtube";
    youtubeVideoId: string;
    provider: {
        tidalTrackId: null;
        youtubeVideoId: string;
    };
}

/** Stable response contract for the personalized home endpoint. */
export interface PersonalizedHomeFeed {
    shelves: {
        listenAgain: PersonalizedTrack[];
        quickPicks: PersonalizedTrack[];
        discovery: PersonalizedTrack[];
    };
    degraded: boolean;
    reason:
        | "insufficient_signals"
        | "provider_partial_failure"
        | "provider_unavailable"
        | null;
    seedCount: number;
    nextCursor: number;
    degradedSources?: string[];
}

type TrackLike = Partial<UnifiedTrackYtMusicRecord> &
    Partial<YtMusicRadioTrack>;

function normalizeExternalCandidateBatch(
    value: UnifiedTrackYtMusicRecord[] | PersonalizedExternalCandidateBatch,
): PersonalizedExternalCandidateBatch {
    if (Array.isArray(value)) {
        return { candidates: value, degradedSources: [] };
    }
    return {
        candidates: Array.isArray(value?.candidates) ? value.candidates : [],
        degradedSources: Array.isArray(value?.degradedSources)
            ? [...new Set(value.degradedSources.filter(Boolean))]
            : [],
    };
}

function nonBlank(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeVideoId(value: unknown): string | null {
    const normalized = nonBlank(value);
    if (!normalized) return null;
    return normalized.startsWith("yt:")
        ? nonBlank(normalized.slice(3))
        : normalized;
}

function resolveArtist(track: TrackLike): string {
    const direct = nonBlank(track.artist);
    if (direct) return direct;

    if (Array.isArray(track.artists)) {
        for (const artist of track.artists) {
            const normalized = nonBlank(artist);
            if (normalized) return normalized;
        }
    }

    return "Unknown Artist";
}

function safeDuration(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.round(value)
        : 0;
}

function fallbackCover(videoId: string): string {
    return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

function normalizeScenarioSearchCandidate(candidate: unknown): unknown {
    if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate)
    ) {
        return candidate;
    }
    const record = candidate as Record<string, unknown>;
    const thumbnails = Array.isArray(record.thumbnails)
        ? record.thumbnails
        : [];
    const thumbnailUrl = [...thumbnails]
        .reverse()
        .map((thumbnail) =>
            typeof thumbnail === "object" && thumbnail !== null
                ? nonBlank((thumbnail as Record<string, unknown>).url)
                : null,
        )
        .find((value): value is string => value !== null);

    return {
        ...record,
        duration:
            typeof record.duration_seconds === "number"
                ? record.duration_seconds
                : record.duration,
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
    };
}

function toPersonalizedTrack(candidate: unknown): PersonalizedTrack | null {
    if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate)
    ) {
        return null;
    }
    const track = candidate as TrackLike;
    const videoId = normalizeVideoId(track.videoId);
    if (!videoId) return null;

    const safeTrack: UnifiedTrackYtMusicRecord = {
        id: nonBlank(track.id) ?? `radio:${videoId}`,
        videoId,
        title: nonBlank(track.title) ?? "Unknown Track",
        artist: resolveArtist(track),
        album: nonBlank(track.album) ?? "Single",
        duration: safeDuration(track.duration),
        thumbnailUrl: nonBlank(track.thumbnailUrl) ?? fallbackCover(videoId),
        artistId: nonBlank(track.artistId),
        albumId: nonBlank(track.albumId),
    };
    const normalized = normalizeYtMusicTrack(safeTrack);
    const coverArt = normalized.album.coverArt ?? fallbackCover(videoId);

    return {
        id: `yt:${videoId}`,
        title: normalized.title,
        duration: normalized.duration,
        trackNo: null,
        artist: normalized.artist,
        album: {
            ...normalized.album,
            coverArt,
            artist: normalized.artist,
        },
        source: "youtube",
        streamSource: "youtube",
        youtubeVideoId: videoId,
        provider: {
            tidalTrackId: null,
            youtubeVideoId: videoId,
        },
    };
}

function collectDistinctTracks(
    candidates: readonly unknown[],
    excludedVideoIds: Set<string>,
    limit: number,
): PersonalizedTrack[] {
    const tracks: PersonalizedTrack[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
        const track = toPersonalizedTrack(candidate);
        if (
            !track ||
            excludedVideoIds.has(track.youtubeVideoId) ||
            seen.has(track.youtubeVideoId)
        ) {
            continue;
        }
        seen.add(track.youtubeVideoId);
        tracks.push(track);
        if (tracks.length >= limit) break;
    }

    return tracks;
}

function collectInterleavedDistinctTracks(
    queues: readonly (readonly unknown[])[],
    excludedVideoIds: Set<string>,
    limit: number,
): PersonalizedTrack[] {
    const tracks: PersonalizedTrack[] = [];
    const seen = new Set<string>();
    const nextIndexes = queues.map(() => 0);
    let foundTrackInRound = true;

    while (tracks.length < limit && foundTrackInRound) {
        foundTrackInRound = false;
        for (let queueIndex = 0; queueIndex < queues.length; queueIndex += 1) {
            const queue = queues[queueIndex] ?? [];
            let nextIndex = nextIndexes[queueIndex] ?? 0;
            while (nextIndex < queue.length) {
                const track = toPersonalizedTrack(queue[nextIndex]);
                nextIndex += 1;
                nextIndexes[queueIndex] = nextIndex;
                if (
                    !track ||
                    excludedVideoIds.has(track.youtubeVideoId) ||
                    seen.has(track.youtubeVideoId)
                ) {
                    continue;
                }

                seen.add(track.youtubeVideoId);
                tracks.push(track);
                foundTrackInRound = true;
                break;
            }
            if (tracks.length >= limit) break;
        }
    }

    return tracks;
}

function addTrackIds(target: Set<string>, tracks: PersonalizedTrack[]): void {
    for (const track of tracks) target.add(track.youtubeVideoId);
}

interface PersonalizedPreferenceProfile {
    trackScores: Map<string, number>;
    artistScores: Map<string, number>;
    knownVideoIds: Set<string>;
    knownArtists: Set<string>;
}

function normalizedArtistKey(value: string): string {
    return value.trim().toLocaleLowerCase("en-US");
}

function addScore(scores: Map<string, number>, key: string, delta: number) {
    scores.set(key, (scores.get(key) ?? 0) + delta);
}

function playbackSignalScore(signal: PersonalizedPlaybackSignal): number {
    const ratio = signal.completionRatio ?? 0;
    const listenedSeconds = signal.listenedSeconds ?? 0;
    if (signal.outcome === "skipped") {
        return ratio <= 0.2 || listenedSeconds < 30 ? -8 : -2;
    }
    // Provider/network failures are availability telemetry, never evidence of
    // dislike. Penalizing them made transient YouTube failures distort taste.
    if (signal.outcome === "failed") return 0;
    if (signal.outcome === "completed" || ratio >= 0.85) return 6;
    if (
        signal.outcome === "meaningful" ||
        ratio >= 0.5 ||
        listenedSeconds >= 240
    ) {
        return 3;
    }
    return 0;
}

function buildPreferenceProfile(
    signals: PersonalizedCatalogSignals,
): PersonalizedPreferenceProfile {
    const trackScores = new Map<string, number>();
    const trackArtists = new Map<string, string>();
    const knownVideoIds = new Set<string>();
    const knownArtists = new Set<string>();
    const positivePlayCounts = new Map<string, number>();
    const playbackSignals = signals.playbackSignals ?? [];
    const explicitlyObservedVideoIds = new Set(
        playbackSignals
            .filter(
                (signal) =>
                    signal.outcome !== null ||
                    signal.listenedSeconds !== null ||
                    signal.completionRatio !== null,
            )
            .map((signal) => normalizeVideoId(signal.track.videoId))
            .filter((videoId): videoId is string => videoId !== null),
    );

    const register = (
        candidate: unknown,
        score: number,
        rememberArtist = score > 0,
    ) => {
        const track = toPersonalizedTrack(candidate);
        if (!track) return;
        knownVideoIds.add(track.youtubeVideoId);
        const artistKey = normalizedArtistKey(track.artist.name);
        if (rememberArtist) knownArtists.add(artistKey);
        trackArtists.set(track.youtubeVideoId, artistKey);
        addScore(trackScores, track.youtubeVideoId, score);
    };

    for (const track of signals.recentPlays) {
        const videoId = normalizeVideoId(track.videoId);
        if (videoId && explicitlyObservedVideoIds.has(videoId)) continue;
        register(track, 0.25);
    }
    for (const track of signals.playlistTracks) register(track, 2);
    for (const track of signals.tasteSeedTracks ?? []) register(track, 4);
    for (const track of signals.likedTracks) register(track, 12);
    for (const signal of playbackSignals) {
        const score = playbackSignalScore(signal);
        register(signal.track, score, score > 0);
        const videoId = normalizeVideoId(signal.track.videoId);
        if (videoId && score >= 3) {
            positivePlayCounts.set(
                videoId,
                (positivePlayCounts.get(videoId) ?? 0) + 1,
            );
        }
    }

    for (const [videoId, count] of positivePlayCounts) {
        if (count > 1) {
            addScore(trackScores, videoId, Math.min(4, Math.log2(count) * 2));
        }
    }

    const artistScores = new Map<string, number>();
    for (const [videoId, score] of trackScores) {
        const artistKey = trackArtists.get(videoId);
        if (!artistKey) continue;
        addScore(artistScores, artistKey, Math.max(-12, Math.min(16, score)));
    }
    for (const [artistKey, score] of artistScores) {
        artistScores.set(artistKey, Math.max(-20, Math.min(24, score)));
    }

    return { trackScores, artistScores, knownVideoIds, knownArtists };
}

function rankSignalTracks(
    candidates: readonly unknown[],
    excludedVideoIds: Set<string>,
    profile: PersonalizedPreferenceProfile,
    limit: number,
): PersonalizedTrack[] {
    return collectDistinctTracks(
        candidates,
        excludedVideoIds,
        candidates.length,
    )
        .map((track, originalIndex) => ({
            track,
            score: profile.trackScores.get(track.youtubeVideoId) ?? 0,
            originalIndex,
        }))
        .filter((entry) => entry.score > 0)
        .sort(
            (left, right) =>
                right.score - left.score ||
                left.originalIndex - right.originalIndex,
        )
        .slice(0, limit)
        .map((entry) => entry.track);
}

function discoveryScore(
    track: PersonalizedTrack,
    profile: PersonalizedPreferenceProfile,
    mode: PersonalizedWaveMode,
    originalIndex: number,
): number {
    const trackScore = profile.trackScores.get(track.youtubeVideoId) ?? 0;
    const artistKey = normalizedArtistKey(track.artist.name);
    const artistScore = profile.artistScores.get(artistKey) ?? 0;
    const knownTrack = profile.knownVideoIds.has(track.youtubeVideoId);
    const knownArtist = profile.knownArtists.has(artistKey);
    const providerOrder = Math.max(0, 2 - originalIndex * 0.02);

    if (mode === "new") {
        return (
            providerOrder +
            (knownTrack ? -100 : 0) +
            (knownArtist ? -3 : 6) +
            Math.max(0, artistScore) * 0.1
        );
    }
    if (mode === "familiar") {
        return (
            providerOrder +
            trackScore * 1.2 +
            artistScore * 0.6 +
            (knownArtist ? 5 : -2)
        );
    }
    return (
        providerOrder +
        trackScore * 0.8 +
        artistScore * 0.35 +
        (knownTrack ? 0 : 0.5)
    );
}

function rankDiscoveryTracks(
    candidates: readonly PersonalizedTrack[],
    profile: PersonalizedPreferenceProfile,
    mode: PersonalizedWaveMode,
    limit: number,
): PersonalizedTrack[] {
    const remaining = candidates
        .map((track, originalIndex) => ({
            track,
            originalIndex,
            score: discoveryScore(track, profile, mode, originalIndex),
        }))
        .sort(
            (left, right) =>
                right.score - left.score ||
                left.originalIndex - right.originalIndex ||
                left.track.youtubeVideoId.localeCompare(
                    right.track.youtubeVideoId,
                ),
        );
    const selected: PersonalizedTrack[] = [];
    let previousArtist: string | null = null;

    while (remaining.length > 0 && selected.length < limit) {
        const diverseIndex = remaining.findIndex(
            (entry) =>
                normalizedArtistKey(entry.track.artist.name) !== previousArtist,
        );
        const [next] = remaining.splice(
            diverseIndex >= 0 ? diverseIndex : 0,
            1,
        );
        selected.push(next.track);
        previousArtist = normalizedArtistKey(next.track.artist.name);
    }
    return selected;
}

function selectDiverseSeedTracks(
    signals: PersonalizedCatalogSignals,
    dislikedVideoIds: Set<string>,
    cursor: number,
    profile: PersonalizedPreferenceProfile,
    mood?: PersonalizedWaveMood,
): PersonalizedTrack[] {
    const signalSources =
        mood === "favorites"
            ? [
                  signals.likedTracks,
                  signals.playlistTracks,
                  signals.recentPlays,
                  signals.tasteSeedTracks ?? [],
              ]
            : mood === "forgotten"
              ? [
                    signals.playlistTracks,
                    signals.likedTracks,
                    signals.recentPlays,
                    signals.tasteSeedTracks ?? [],
                ]
              : [
                    signals.recentPlays,
                    signals.likedTracks,
                    signals.playlistTracks,
                    signals.tasteSeedTracks ?? [],
                ];
    const selected: PersonalizedTrack[] = [];
    const exclusions = new Set(dislikedVideoIds);

    for (const source of signalSources) {
        const [track] = rotateCandidates(
            rankSignalTracks(source, exclusions, profile, source.length),
            cursor,
        );
        if (!track) continue;
        selected.push(track);
        exclusions.add(track.youtubeVideoId);
    }

    if (selected.length < MAX_RADIO_SEEDS) {
        selected.push(
            ...rotateCandidates(
                rankSignalTracks(
                    signalSources.flat(),
                    exclusions,
                    profile,
                    signalSources.flat().length,
                ),
                cursor,
            ).slice(0, MAX_RADIO_SEEDS - selected.length),
        );
    }

    return selected;
}

function rotateCandidates<T>(candidates: readonly T[], cursor: number): T[] {
    if (candidates.length < 2) return [...candidates];
    const offset = cursor % candidates.length;
    return [...candidates.slice(offset), ...candidates.slice(0, offset)];
}

function buildDislikedVideoIds(entityIds: string[]): Set<string> {
    const disliked = new Set<string>();
    for (const entityId of entityIds) {
        const videoId = normalizeVideoId(entityId);
        if (videoId) disliked.add(videoId);
    }
    return disliked;
}

function collectCanonicalEntityIds(candidates: readonly unknown[]): string[] {
    const canonicalEntityIds = new Set<string>();

    for (const candidate of candidates) {
        const track = toPersonalizedTrack(candidate);
        if (track) canonicalEntityIds.add(track.id);
    }

    return [...canonicalEntityIds];
}

async function loadDislikedEntityIdsFromPrisma(
    userId: string,
    canonicalEntityIds: string[],
): Promise<string[]> {
    if (canonicalEntityIds.length === 0) return [];

    const rows = await prisma.dislikedEntity.findMany({
        where: {
            userId,
            entityType: "track",
            entityId: { in: canonicalEntityIds },
        },
        select: { entityId: true },
    });
    return rows.map((row) => row.entityId);
}

async function loadSignalsFromPrisma(
    userId: string,
): Promise<PersonalizedCatalogSignals> {
    const [recentRows, likedRows, playlistRows, settings] = await Promise.all([
        prisma.play.findMany({
            where: { userId, trackYtMusicId: { not: null } },
            orderBy: { playedAt: "desc" },
            take: SIGNAL_READ_LIMIT,
            select: {
                listenedSeconds: true,
                completionRatio: true,
                outcome: true,
                playedAt: true,
                waveMode: true,
                trackYtMusic: { select: YOUTUBE_TRACK_SELECT },
            },
        }),
        prisma.likedRemoteTrack.findMany({
            where: { userId, trackYtMusicId: { not: null } },
            orderBy: { likedAt: "desc" },
            take: SIGNAL_READ_LIMIT,
            select: {
                trackYtMusic: { select: YOUTUBE_TRACK_SELECT },
            },
        }),
        prisma.playlistItem.findMany({
            where: {
                trackYtMusicId: { not: null },
                playlist: { is: { userId } },
            },
            orderBy: [{ playlistId: "asc" }, { sort: "asc" }],
            take: SIGNAL_READ_LIMIT,
            select: {
                trackYtMusic: { select: YOUTUBE_TRACK_SELECT },
            },
        }),
        prisma.userSettings.findUnique({
            where: { userId },
            select: { tasteProfile: true },
        }),
    ]);

    const recentPlays = recentRows.flatMap((row) =>
        row.trackYtMusic ? [row.trackYtMusic] : [],
    );
    const tasteSeedTracks =
        parseStoredTasteProfile(settings?.tasteProfile)?.seedTracks ?? [];
    return {
        recentPlays,
        likedTracks: likedRows.flatMap((row) =>
            row.trackYtMusic ? [row.trackYtMusic] : [],
        ),
        playlistTracks: playlistRows.flatMap((row) =>
            row.trackYtMusic ? [row.trackYtMusic] : [],
        ),
        tasteSeedTracks,
        dislikedEntityIds: [],
        playbackSignals: recentRows.flatMap((row) => {
            if (!row.trackYtMusic) return [];
            const outcome =
                row.outcome === "meaningful" ||
                row.outcome === "completed" ||
                row.outcome === "skipped" ||
                row.outcome === "failed"
                    ? row.outcome
                    : null;
            const waveMode =
                row.waveMode === "for-you" ||
                row.waveMode === "new" ||
                row.waveMode === "familiar"
                    ? row.waveMode
                    : null;
            return [
                {
                    track: row.trackYtMusic,
                    listenedSeconds: row.listenedSeconds,
                    completionRatio: row.completionRatio,
                    outcome,
                    playedAt: row.playedAt,
                    waveMode,
                },
            ];
        }),
    };
}

function validateRequest(
    userId: string,
    limit: number,
    options: PersonalizedCatalogOptions,
): void {
    if (userId.trim().length === 0) {
        throw new TypeError("A user id is required");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HOME_SHELF_LIMIT) {
        throw new RangeError(
            "Personalized shelf limit must be between 1 and 25",
        );
    }
    const cursor = options.cursor ?? 0;
    if (
        !Number.isInteger(cursor) ||
        cursor < 0 ||
        cursor > MAX_CONTINUATION_CURSOR
    ) {
        throw new RangeError("Personalized cursor is out of range");
    }
    if (
        options.excludeVideoIds &&
        options.excludeVideoIds.length > MAX_CONTINUATION_EXCLUSIONS
    ) {
        throw new RangeError("Too many personalized continuation exclusions");
    }
    if (
        options.mode !== undefined &&
        options.mode !== "for-you" &&
        options.mode !== "new" &&
        options.mode !== "familiar"
    ) {
        throw new RangeError("Unsupported personalized Wave mode");
    }
    if (
        options.mood !== undefined &&
        options.mood !== "calm" &&
        options.mood !== "energetic" &&
        options.mood !== "focus" &&
        options.mood !== "workout" &&
        options.mood !== "favorites" &&
        options.mood !== "forgotten"
    ) {
        throw new RangeError("Unsupported personalized Wave mood");
    }
}

function normalizeRequestedExclusions(
    videoIds: readonly string[] | undefined,
): Set<string> {
    const exclusions = new Set<string>();
    for (const videoId of videoIds ?? []) {
        const normalized = normalizeVideoId(videoId);
        if (normalized) exclusions.add(normalized);
    }
    return exclusions;
}

function radioResultLimit(shelfLimit: number): number {
    return Math.min(
        MAX_RADIO_RESULT_LIMIT,
        Math.max(MIN_RADIO_RESULT_LIMIT, shelfLimit * 3),
    );
}

/**
 * Builds three bounded personalized shelves from one user's persisted remote
 * signals and a small, failure-isolated set of YouTube Music radio calls.
 */
export class PersonalizedCatalogService {
    constructor(
        private readonly dependencies: PersonalizedCatalogDependencies,
    ) {}

    /** Build a personalized, directly playable home feed for one user. */
    async getHomeFeed(
        userId: string,
        limit: number,
        options: PersonalizedCatalogOptions = {},
    ): Promise<PersonalizedHomeFeed> {
        validateRequest(userId, limit, options);
        const cursor = options.cursor ?? 0;
        const mode = options.mode ?? "for-you";
        const nextCursor = cursor >= MAX_CONTINUATION_CURSOR ? 0 : cursor + 1;
        const signals = await this.dependencies.loadSignals(userId);
        const preferenceProfile = buildPreferenceProfile(signals);
        const signalCandidates = [
            ...signals.recentPlays,
            ...signals.likedTracks,
            ...signals.playlistTracks,
            ...(signals.tasteSeedTracks ?? []),
        ];
        const exactSignalDislikes =
            await this.dependencies.loadDislikedEntityIds(
                userId,
                collectCanonicalEntityIds(signalCandidates),
            );
        const dislikedVideoIds = buildDislikedVideoIds([
            ...signals.dislikedEntityIds,
            ...exactSignalDislikes,
        ]);
        const requestedExclusions = normalizeRequestedExclusions(
            options.excludeVideoIds,
        );
        const shelfExclusions = new Set([
            ...dislikedVideoIds,
            ...requestedExclusions,
        ]);

        const listenAgain = rankSignalTracks(
            signals.recentPlays,
            shelfExclusions,
            preferenceProfile,
            limit,
        );
        const recentVideoIds = new Set(
            signals.recentPlays
                .map((track) => normalizeVideoId(track.videoId))
                .filter((videoId): videoId is string => videoId !== null),
        );
        const quickPickExclusions = new Set([
            ...shelfExclusions,
            ...recentVideoIds,
        ]);
        const quickPicks = rankSignalTracks(
            [
                ...signals.likedTracks,
                ...signals.playlistTracks,
                ...(signals.tasteSeedTracks ?? []),
            ],
            quickPickExclusions,
            preferenceProfile,
            limit,
        );

        const seedTracks = selectDiverseSeedTracks(
            signals,
            dislikedVideoIds,
            cursor,
            preferenceProfile,
            options.mood,
        );
        const seedVideoIds = seedTracks.map((track) => track.youtubeVideoId);

        const listenBrainzCandidatesPromise = Promise.resolve()
            .then(() =>
                this.dependencies.getListenBrainzCandidates(
                    userId,
                    limit,
                    cursor,
                ),
            )
            .then(normalizeExternalCandidateBatch)
            .catch((error: unknown) => {
                log.warn(
                    "Optional ListenBrainz recommendations are unavailable",
                    { userId },
                    error,
                );
                return {
                    candidates: [],
                    degradedSources: ["listenbrainz"],
                } satisfies PersonalizedExternalCandidateBatch;
            });
        const requestedMood = options.mood;
        const scenarioCandidatesPromise = requestedMood
            ? Promise.resolve()
                  .then(() =>
                      this.dependencies.getScenarioCandidates(
                          userId,
                          requestedMood,
                          radioResultLimit(limit),
                      ),
                  )
                  .then((candidates) => ({
                      candidates: Array.isArray(candidates) ? candidates : [],
                      degradedSources: [],
                  }))
                  .catch((error: unknown) => {
                      log.warn(
                          "Optional Wave mood search is unavailable",
                          { userId, mood: requestedMood },
                          error,
                      );
                      return {
                          candidates: [],
                          degradedSources: ["mood-search"],
                      };
                  })
            : Promise.resolve({ candidates: [], degradedSources: [] });

        if (seedVideoIds.length === 0) {
            const [listenBrainzBatch, scenarioBatch] = await Promise.all([
                listenBrainzCandidatesPromise,
                scenarioCandidatesPromise,
            ]);
            const listenBrainzCandidates = listenBrainzBatch.candidates;
            const scenarioCandidates = scenarioBatch.candidates;
            const degradedSources = [
                ...listenBrainzBatch.degradedSources,
                ...scenarioBatch.degradedSources,
            ];
            const externalDislikes =
                await this.dependencies.loadDislikedEntityIds(
                    userId,
                    collectCanonicalEntityIds([
                        ...scenarioCandidates,
                        ...listenBrainzCandidates,
                    ]),
                );
            const externalExclusions = new Set([
                ...dislikedVideoIds,
                ...buildDislikedVideoIds(externalDislikes),
                ...requestedExclusions,
            ]);
            const discovery = rankDiscoveryTracks(
                collectDistinctTracks(
                    [...scenarioCandidates, ...listenBrainzCandidates],
                    externalExclusions,
                    MAX_DISCOVERY_CANDIDATES,
                ),
                preferenceProfile,
                mode,
                limit,
            );
            return {
                shelves: { listenAgain, quickPicks, discovery },
                degraded: degradedSources.length > 0,
                reason:
                    degradedSources.length > 0
                        ? discovery.length > 0
                            ? "provider_partial_failure"
                            : "provider_unavailable"
                        : discovery.length > 0
                          ? null
                          : "insufficient_signals",
                seedCount: 0,
                nextCursor,
                degradedSources,
            };
        }

        const requestedRadioLimit = radioResultLimit(limit);
        const [radioResults, listenBrainzBatch, scenarioBatch] =
            await Promise.all([
                Promise.allSettled(
                    seedVideoIds.map(async (seedVideoId) => {
                        const queue = await this.dependencies.getRadio(
                            seedVideoId,
                            requestedRadioLimit,
                        );
                        if (!queue || !Array.isArray(queue.tracks)) {
                            throw new TypeError(
                                "Invalid YouTube Music radio response",
                            );
                        }
                        const boundedTracks = queue.tracks.slice(
                            0,
                            requestedRadioLimit,
                        );
                        const hasPlayableTrack = boundedTracks.some((track) => {
                            if (
                                typeof track !== "object" ||
                                track === null ||
                                Array.isArray(track)
                            ) {
                                return false;
                            }
                            return (
                                normalizeVideoId(
                                    (track as TrackLike).videoId,
                                ) !== null
                            );
                        });
                        if (!hasPlayableTrack) {
                            throw new TypeError(
                                "Empty YouTube Music radio response",
                            );
                        }
                        return boundedTracks;
                    }),
                ),
                listenBrainzCandidatesPromise,
                scenarioCandidatesPromise,
            ]);
        const listenBrainzCandidates = listenBrainzBatch.candidates;
        const scenarioCandidates = scenarioBatch.candidates;
        const failedRadioCount = radioResults.filter(
            (result) => result.status === "rejected",
        ).length;
        const successfulRadioQueues = radioResults.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
        );
        const discoveryCandidates = successfulRadioQueues.flat();
        const exactCandidateDislikes =
            await this.dependencies.loadDislikedEntityIds(
                userId,
                collectCanonicalEntityIds([
                    ...signalCandidates,
                    ...discoveryCandidates,
                    ...scenarioCandidates,
                    ...listenBrainzCandidates,
                ]),
            );
        for (const dislikedVideoId of buildDislikedVideoIds(
            exactCandidateDislikes,
        )) {
            dislikedVideoIds.add(dislikedVideoId);
        }

        const finalListenAgain = rankSignalTracks(
            signals.recentPlays,
            new Set([...dislikedVideoIds, ...requestedExclusions]),
            preferenceProfile,
            limit,
        );
        const finalQuickPicks = rankSignalTracks(
            [
                ...signals.likedTracks,
                ...signals.playlistTracks,
                ...(signals.tasteSeedTracks ?? []),
            ],
            new Set([
                ...dislikedVideoIds,
                ...requestedExclusions,
                ...recentVideoIds,
            ]),
            preferenceProfile,
            limit,
        );
        const discoveryExclusions = new Set([
            ...dislikedVideoIds,
            ...requestedExclusions,
            ...recentVideoIds,
            ...seedVideoIds,
        ]);
        addTrackIds(discoveryExclusions, finalListenAgain);
        addTrackIds(discoveryExclusions, finalQuickPicks);
        const scenarioDiscovery = collectDistinctTracks(
            scenarioCandidates,
            discoveryExclusions,
            MAX_DISCOVERY_CANDIDATES,
        );
        const providerExclusions = new Set(discoveryExclusions);
        addTrackIds(providerExclusions, scenarioDiscovery);
        const providerDiscovery = collectInterleavedDistinctTracks(
            successfulRadioQueues,
            providerExclusions,
            MAX_DISCOVERY_CANDIDATES - scenarioDiscovery.length,
        );
        const externalExclusions = new Set(providerExclusions);
        addTrackIds(externalExclusions, providerDiscovery);
        const externalDiscovery = collectDistinctTracks(
            listenBrainzCandidates,
            externalExclusions,
            MAX_DISCOVERY_CANDIDATES - providerDiscovery.length,
        );
        const discovery = rankDiscoveryTracks(
            [...scenarioDiscovery, ...providerDiscovery, ...externalDiscovery],
            preferenceProfile,
            mode,
            limit,
        );

        const degradedSources = [
            ...(failedRadioCount > 0 ? ["youtube-radio"] : []),
            ...listenBrainzBatch.degradedSources,
            ...scenarioBatch.degradedSources,
        ];
        const hasProviderResult =
            discovery.length > 0 || successfulRadioQueues.length > 0;
        const reason =
            degradedSources.length === 0
                ? null
                : hasProviderResult
                  ? "provider_partial_failure"
                  : "provider_unavailable";

        return {
            shelves: {
                listenAgain: finalListenAgain,
                quickPicks: finalQuickPicks,
                discovery,
            },
            degraded: degradedSources.length > 0,
            reason,
            seedCount: seedVideoIds.length,
            nextCursor,
            degradedSources,
        };
    }
}

/** Process-wide personalized catalog service backed by Prisma and YT Music. */
export const personalizedCatalogService = new PersonalizedCatalogService({
    loadSignals: loadSignalsFromPrisma,
    loadDislikedEntityIds: loadDislikedEntityIdsFromPrisma,
    getRadio: (seedVideoId, limit) =>
        ytMusicService.getRadio(seedVideoId, limit),
    getListenBrainzCandidates: async (userId, limit, cursor) => {
        const batch = await listenBrainzRecommendationAdapter.getCandidateBatch(
            userId,
            limit,
            cursor,
        );
        return {
            candidates: batch.candidates.flatMap((candidate) => {
                const videoId = candidate.provider.youtubeVideoId;
                if (!videoId) return [];
                return [
                    {
                        id: candidate.id,
                        videoId,
                        title: candidate.title,
                        artist: candidate.artist.name,
                        album: candidate.album.title,
                        duration: candidate.duration,
                        thumbnailUrl: candidate.album.coverArt,
                    },
                ];
            }),
            degradedSources: batch.degradedSources,
        };
    },
    getScenarioCandidates: async (userId, mood, limit) => {
        const query = SCENARIO_SEARCH_QUERY[mood];
        if (!query) return [];
        const result = await ytMusicService.search(
            userId,
            query,
            "songs",
            limit,
            { timeoutMs: 8_000, maxRetries: 0 },
        );
        return Array.isArray(result.results)
            ? result.results.map(normalizeScenarioSearchCandidate)
            : [];
    },
});
