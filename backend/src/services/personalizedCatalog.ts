import type { UnifiedTrackYtMusicRecord } from "./unifiedTrackResponse";
import { normalizeYtMusicTrack } from "./unifiedTrackResponse";
import {
    ytMusicService,
    type YtMusicRadioQueue,
    type YtMusicRadioTrack,
} from "./youtubeMusic";
import { prisma } from "../utils/db";

const SIGNAL_READ_LIMIT = 100;
const MAX_RADIO_SEEDS = 3;
const MAX_HOME_SHELF_LIMIT = 25;
const MIN_RADIO_RESULT_LIMIT = 12;
const MAX_RADIO_RESULT_LIMIT = 50;

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
    dislikedEntityIds: string[];
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
}

type TrackLike = Partial<UnifiedTrackYtMusicRecord> &
    Partial<YtMusicRadioTrack>;

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

function addTrackIds(target: Set<string>, tracks: PersonalizedTrack[]): void {
    for (const track of tracks) target.add(track.youtubeVideoId);
}

function selectDiverseSeedTracks(
    signals: PersonalizedCatalogSignals,
    dislikedVideoIds: Set<string>,
): PersonalizedTrack[] {
    const signalSources = [
        signals.recentPlays,
        signals.likedTracks,
        signals.playlistTracks,
    ];
    const selected: PersonalizedTrack[] = [];
    const exclusions = new Set(dislikedVideoIds);

    for (const source of signalSources) {
        const [track] = collectDistinctTracks(source, exclusions, 1);
        if (!track) continue;
        selected.push(track);
        exclusions.add(track.youtubeVideoId);
    }

    if (selected.length < MAX_RADIO_SEEDS) {
        selected.push(
            ...collectDistinctTracks(
                signalSources.flat(),
                exclusions,
                MAX_RADIO_SEEDS - selected.length,
            ),
        );
    }

    return selected;
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
    const [recentRows, likedRows, playlistRows] = await Promise.all([
        prisma.play.findMany({
            where: { userId, trackYtMusicId: { not: null } },
            orderBy: { playedAt: "desc" },
            take: SIGNAL_READ_LIMIT,
            select: {
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
    ]);

    return {
        recentPlays: recentRows.flatMap((row) =>
            row.trackYtMusic ? [row.trackYtMusic] : [],
        ),
        likedTracks: likedRows.flatMap((row) =>
            row.trackYtMusic ? [row.trackYtMusic] : [],
        ),
        playlistTracks: playlistRows.flatMap((row) =>
            row.trackYtMusic ? [row.trackYtMusic] : [],
        ),
        dislikedEntityIds: [],
    };
}

function validateRequest(userId: string, limit: number): void {
    if (userId.trim().length === 0) {
        throw new TypeError("A user id is required");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HOME_SHELF_LIMIT) {
        throw new RangeError(
            "Personalized shelf limit must be between 1 and 25",
        );
    }
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
    ): Promise<PersonalizedHomeFeed> {
        validateRequest(userId, limit);
        const signals = await this.dependencies.loadSignals(userId);
        const signalCandidates = [
            ...signals.recentPlays,
            ...signals.likedTracks,
            ...signals.playlistTracks,
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

        const listenAgain = collectDistinctTracks(
            signals.recentPlays,
            dislikedVideoIds,
            limit,
        );
        const recentVideoIds = new Set(
            signals.recentPlays
                .map((track) => normalizeVideoId(track.videoId))
                .filter((videoId): videoId is string => videoId !== null),
        );
        const quickPickExclusions = new Set([
            ...dislikedVideoIds,
            ...recentVideoIds,
        ]);
        const quickPicks = collectDistinctTracks(
            [...signals.likedTracks, ...signals.playlistTracks],
            quickPickExclusions,
            limit,
        );

        const seedTracks = selectDiverseSeedTracks(signals, dislikedVideoIds);
        const seedVideoIds = seedTracks.map((track) => track.youtubeVideoId);

        if (seedVideoIds.length === 0) {
            return {
                shelves: { listenAgain, quickPicks, discovery: [] },
                degraded: false,
                reason: "insufficient_signals",
                seedCount: 0,
            };
        }

        const requestedRadioLimit = radioResultLimit(limit);
        const radioResults = await Promise.allSettled(
            seedVideoIds.map(async (seedVideoId) => {
                const queue = await this.dependencies.getRadio(
                    seedVideoId,
                    requestedRadioLimit,
                );
                if (!queue || !Array.isArray(queue.tracks)) {
                    throw new TypeError("Invalid YouTube Music radio response");
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
                        normalizeVideoId((track as TrackLike).videoId) !== null
                    );
                });
                if (!hasPlayableTrack) {
                    throw new TypeError("Empty YouTube Music radio response");
                }
                return boundedTracks;
            }),
        );
        const failedRadioCount = radioResults.filter(
            (result) => result.status === "rejected",
        ).length;
        const discoveryCandidates = radioResults.flatMap((result) =>
            result.status === "fulfilled" ? result.value : [],
        );
        const exactCandidateDislikes =
            await this.dependencies.loadDislikedEntityIds(
                userId,
                collectCanonicalEntityIds([
                    ...signalCandidates,
                    ...discoveryCandidates,
                ]),
            );
        for (const dislikedVideoId of buildDislikedVideoIds(
            exactCandidateDislikes,
        )) {
            dislikedVideoIds.add(dislikedVideoId);
        }

        const finalListenAgain = collectDistinctTracks(
            signals.recentPlays,
            dislikedVideoIds,
            limit,
        );
        const finalQuickPicks = collectDistinctTracks(
            [...signals.likedTracks, ...signals.playlistTracks],
            new Set([...dislikedVideoIds, ...recentVideoIds]),
            limit,
        );
        const discoveryExclusions = new Set([
            ...dislikedVideoIds,
            ...recentVideoIds,
            ...seedVideoIds,
        ]);
        addTrackIds(discoveryExclusions, finalListenAgain);
        addTrackIds(discoveryExclusions, finalQuickPicks);
        const discovery = collectDistinctTracks(
            discoveryCandidates,
            discoveryExclusions,
            limit,
        );

        const reason =
            failedRadioCount === 0
                ? null
                : failedRadioCount === radioResults.length
                  ? "provider_unavailable"
                  : "provider_partial_failure";

        return {
            shelves: {
                listenAgain: finalListenAgain,
                quickPicks: finalQuickPicks,
                discovery,
            },
            degraded: failedRadioCount > 0,
            reason,
            seedCount: seedVideoIds.length,
        };
    }
}

/** Process-wide personalized catalog service backed by Prisma and YT Music. */
export const personalizedCatalogService = new PersonalizedCatalogService({
    loadSignals: loadSignalsFromPrisma,
    loadDislikedEntityIds: loadDislikedEntityIdsFromPrisma,
    getRadio: (seedVideoId, limit) =>
        ytMusicService.getRadio(seedVideoId, limit),
});
