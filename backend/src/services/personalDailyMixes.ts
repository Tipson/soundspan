import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { parseStoredTasteProfile } from "./tasteProfile";
import { tasteArtistTags } from "./tasteArtistGenres";
import { lastFmService } from "./lastfm";
import { ytMusicService } from "./youtubeMusic";
import type { PersonalizedTrack } from "./personalizedCatalog";
import {
    buildRecommendationAlbumKey,
    normalizeRecommendationArtistKey,
} from "./recommendations/identityKeys";

const MAX_DIRECTIONS = 6;
const DIRECTION_CONCURRENCY = 3;
const MAX_TRACKS = 40;
const MIN_TRACKS = 20;
const RADIO_LIMIT = 50;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHED_ACCOUNTS = 100;
const log = logger.child("PersonalDailyMixes");

export interface DailyMixDirection {
    key: string;
    label: string;
    query: string;
    kind?: "genre" | "artist";
}

export interface DailyMixSong {
    videoId: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    thumbnailUrl: string | null;
}

interface RecentlyPlayedSong {
    videoId: string;
    playedAt: Date;
}

/** Exact served composition and account used to attribute later engagement. */
export interface RecordDailyMixGenerationInput {
    userId: string;
    mix: PersonalDailyMix;
    generatedAt: Date;
    latencyMs: number;
}

export interface PersonalDailyMixDependencies {
    loadDirections: (userId: string) => Promise<DailyMixDirection[]>;
    loadFamiliar: (userId: string) => Promise<DailyMixSong[]>;
    loadRecentlyPlayed: (userId: string) => Promise<RecentlyPlayedSong[]>;
    loadGenreArtists: (genre: string) => Promise<string[]>;
    searchSongs: (userId: string, query: string) => Promise<DailyMixSong[]>;
    getRadio: (seedVideoId: string) => Promise<DailyMixSong[]>;
    loadDislikedIds: (
        userId: string,
        videoIds: string[],
    ) => Promise<Set<string>>;
    loadDislikeState: (userId: string) => Promise<string>;
    /** Artist keys with two distinct active track dislikes in the last 30 days. */
    loadSuppressedArtistKeys: (userId: string) => Promise<Set<string>>;
    recordMixGeneration: (
        input: RecordDailyMixGenerationInput,
    ) => Promise<string>;
    now: () => Date;
}

export interface PersonalDailyMix {
    key: string;
    title: string;
    description: string;
    tracks: PersonalizedTrack[];
    generationId?: string;
}

function artistKey(value: string): string {
    return value.trim().toLocaleLowerCase("en-US");
}

function playable(song: DailyMixSong): boolean {
    return (
        /^[A-Za-z0-9_-]{1,64}$/.test(song.videoId) &&
        song.title.trim().length > 0 &&
        song.artist.trim().length > 0 &&
        Number.isFinite(song.duration) &&
        song.duration >= 45 &&
        song.duration <= 900
    );
}

function distinct(songs: readonly DailyMixSong[]): DailyMixSong[] {
    const seen = new Set<string>();
    return songs.filter((song) => {
        if (!playable(song) || seen.has(song.videoId)) return false;
        seen.add(song.videoId);
        return true;
    });
}

function toTrack(song: DailyMixSong): PersonalizedTrack {
    const coverArt =
        song.thumbnailUrl ||
        `https://i.ytimg.com/vi/${encodeURIComponent(song.videoId)}/hqdefault.jpg`;
    const artist = { id: null, name: song.artist };
    return {
        id: `yt:${song.videoId}`,
        title: song.title,
        duration: Math.round(song.duration),
        trackNo: null,
        artist,
        album: {
            id: null,
            title: song.album || "Single",
            coverArt,
            artist,
        },
        source: "youtube",
        streamSource: "youtube",
        youtubeVideoId: song.videoId,
        provider: { tidalTrackId: null, youtubeVideoId: song.videoId },
    };
}

function mergeFamiliarAndNew(
    familiar: DailyMixSong[],
    newSongs: DailyMixSong[],
): DailyMixSong[] {
    const songs: DailyMixSong[] = [];
    let familiarIndex = 0;
    let newIndex = 0;
    while (songs.length < MAX_TRACKS) {
        const next =
            songs.length % 3 !== 2 && familiarIndex < familiar.length
                ? familiar[familiarIndex++]
                : (newSongs[newIndex++] ?? familiar[familiarIndex++]);
        if (!next) break;
        songs.push(next);
    }
    return distinct(songs).slice(0, MAX_TRACKS);
}

/** Builds distinct, playable daily mixes from account tastes and listening. */
export class PersonalDailyMixService {
    private readonly cache = new Map<
        string,
        { expiresAt: number; result: Promise<{ mixes: PersonalDailyMix[] }> }
    >();

    constructor(private readonly dependencies: PersonalDailyMixDependencies) {}

    async getMixes(userId: string): Promise<{ mixes: PersonalDailyMix[] }> {
        if (!userId.trim()) throw new TypeError("A user id is required");
        const startedAt = Date.now();
        const [directions, familiarSongs, dislikeState, suppressedArtists] =
            await Promise.all([
                this.dependencies.loadDirections(userId),
                this.dependencies.loadFamiliar(userId),
                this.dependencies.loadDislikeState(userId),
                this.dependencies.loadSuppressedArtistKeys(userId),
            ]);
        const familiar = familiarSongs.filter(
            (song) => !suppressedArtists.has(artistKey(song.artist)),
        );
        const seenArtists = new Set<string>();
        const familiarDirections: DailyMixDirection[] = familiar.flatMap(
            (song) => {
                const key = artistKey(song.artist);
                if (!key || key === "unknown" || seenArtists.has(key))
                    return [];
                seenArtists.add(key);
                return [
                    {
                        key: `artist:${song.artist}`,
                        label: song.artist,
                        query: `${song.artist} songs`,
                        kind: "artist",
                    },
                ];
            },
        );
        const seenDirections = new Set<string>();
        const chosen = [...directions, ...familiarDirections]
            .filter((direction) => {
                if (
                    direction.kind === "artist" &&
                    suppressedArtists.has(artistKey(direction.label))
                )
                    return false;
                const key = `${direction.kind ?? "genre"}:${artistKey(direction.label)}`;
                if (seenDirections.has(key)) return false;
                seenDirections.add(key);
                return true;
            })
            .slice(0, MAX_DIRECTIONS);
        if (chosen.length === 0) return { mixes: [] };
        const now = this.dependencies.now().getTime();
        const key = JSON.stringify([
            userId,
            Math.floor(now / 86_400_000),
            dislikeState,
            [...suppressedArtists].sort(),
            chosen.map((direction) => direction.key),
            familiar.map((song) => song.videoId),
        ]);
        const cached = this.cache.get(key);
        if (cached && cached.expiresAt > now) return cached.result;
        if (cached) this.cache.delete(key);
        const result = this.dependencies
            .loadRecentlyPlayed(userId)
            .catch((error: unknown) => {
                log.warn(
                    "Daily mix playback history unavailable",
                    { userId },
                    error,
                );
                return [];
            })
            .then((recentlyPlayed) =>
                this.buildMixes(
                    userId,
                    chosen,
                    familiar,
                    recentlyPlayed,
                    suppressedArtists,
                ),
            )
            .then(async ({ mixes }) => ({
                mixes: await Promise.all(
                    mixes.map(async (mix) => {
                        try {
                            const generationId =
                                await this.dependencies.recordMixGeneration({
                                    userId,
                                    mix,
                                    generatedAt: new Date(now),
                                    latencyMs: Math.max(
                                        0,
                                        Date.now() - startedAt,
                                    ),
                                });
                            return { ...mix, generationId };
                        } catch (error: unknown) {
                            log.warn(
                                "Daily mix attribution unavailable",
                                { userId, mixKey: mix.key },
                                error,
                            );
                            return mix;
                        }
                    }),
                ),
            }));
        this.cache.set(key, { expiresAt: now + CACHE_TTL_MS, result });
        if (this.cache.size > MAX_CACHED_ACCOUNTS) {
            this.cache.delete(this.cache.keys().next().value!);
        }
        result.catch(() => {
            if (this.cache.get(key)?.result === result) this.cache.delete(key);
        });
        return result;
    }

    private async buildMixes(
        userId: string,
        chosen: DailyMixDirection[],
        familiar: DailyMixSong[],
        recentlyPlayed: RecentlyPlayedSong[],
        suppressedArtists: ReadonlySet<string>,
    ): Promise<{ mixes: PersonalDailyMix[] }> {
        const allowedArtist = (song: DailyMixSong) =>
            !suppressedArtists.has(artistKey(song.artist));
        const recentTimes = new Map<string, number>();
        for (const play of recentlyPlayed) {
            const time = play.playedAt.getTime();
            if (!Number.isFinite(time)) continue;
            recentTimes.set(
                play.videoId,
                Math.max(recentTimes.get(play.videoId) ?? -Infinity, time),
            );
        }
        const hasFreshPool = (songs: DailyMixSong[]) =>
            distinct(songs).filter((song) => !recentTimes.has(song.videoId))
                .length >= MAX_TRACKS;
        const pools: DailyMixSong[][] = [];
        for (
            let start = 0;
            start < chosen.length;
            start += DIRECTION_CONCURRENCY
        ) {
            const batch = await Promise.all(
                chosen
                    .slice(start, start + DIRECTION_CONCURRENCY)
                    .map(async (direction) => {
                        try {
                            const catalogArtists =
                                direction.kind === "genre"
                                    ? await this.dependencies
                                          .loadGenreArtists(direction.label)
                                          .catch(() => [])
                                    : [];
                            const genreArtists = catalogArtists.filter(
                                (artist) =>
                                    !suppressedArtists.has(artistKey(artist)),
                            );
                            const familiarArtists = new Set(
                                familiar.map((song) => artistKey(song.artist)),
                            );
                            const matched = genreArtists.filter((artist) =>
                                familiarArtists.has(artistKey(artist)),
                            );
                            const rotating = genreArtists.slice(0, 12);
                            const day = Math.floor(
                                this.dependencies.now().getTime() / 86_400_000,
                            );
                            const offset =
                                rotating.length > 0 ? day % rotating.length : 0;
                            const artistQueries = [
                                ...matched,
                                ...rotating.slice(offset),
                                ...rotating.slice(0, offset),
                            ]
                                .filter(
                                    (artist, index, all) =>
                                        all.findIndex(
                                            (candidate) =>
                                                artistKey(candidate) ===
                                                artistKey(artist),
                                        ) === index,
                                )
                                .slice(0, 2);
                            const queries = [
                                ...artistQueries.map(
                                    (artist) => `${artist} songs`,
                                ),
                                direction.query,
                            ].slice(0, 2);
                            const songs: DailyMixSong[] = [];
                            for (const query of queries) {
                                try {
                                    const searched = distinct(
                                        await this.dependencies.searchSongs(
                                            userId,
                                            query,
                                        ),
                                    ).filter(allowedArtist);
                                    const artist = query.endsWith(" songs")
                                        ? query.slice(0, -" songs".length)
                                        : null;
                                    const matchedSongs = artist
                                        ? searched.filter(
                                              (song) =>
                                                  artistKey(song.artist) ===
                                                  artistKey(artist),
                                          )
                                        : searched;
                                    if (matchedSongs.length === 0) continue;
                                    songs.push(...matchedSongs);
                                    const seeds = matchedSongs.slice(
                                        0,
                                        direction.kind === "artist" ? 3 : 1,
                                    );
                                    for (const seed of seeds) {
                                        try {
                                            const radio =
                                                await this.dependencies.getRadio(
                                                    seed.videoId,
                                                );
                                            songs.push(
                                                ...radio.filter(allowedArtist),
                                            );
                                            if (hasFreshPool(songs)) break;
                                        } catch (error) {
                                            log.warn(
                                                "Daily mix seed unavailable",
                                                {
                                                    userId,
                                                    direction: direction.key,
                                                },
                                                error,
                                            );
                                        }
                                    }
                                    if (hasFreshPool(songs)) break;
                                } catch (error) {
                                    log.warn(
                                        "Daily mix seed unavailable",
                                        {
                                            userId,
                                            direction: direction.key,
                                        },
                                        error,
                                    );
                                }
                            }
                            return distinct(songs);
                        } catch (error) {
                            log.warn(
                                "Daily mix direction unavailable",
                                {
                                    userId,
                                    direction: direction.key,
                                },
                                error,
                            );
                            return [];
                        }
                    }),
            );
            pools.push(...batch);
        }
        const allIds = [
            ...new Set(
                [...pools.flat(), ...familiar].map((song) => song.videoId),
            ),
        ];
        const disliked = await this.dependencies.loadDislikedIds(
            userId,
            allIds,
        );
        const oldestPlayFirst = (left: DailyMixSong, right: DailyMixSong) =>
            (recentTimes.get(left.videoId) ?? 0) -
            (recentTimes.get(right.videoId) ?? 0);
        const usedAcrossMixes = new Set<string>();
        const mixes = chosen.flatMap((direction, index) => {
            const pool = pools[index].filter(
                (song) =>
                    !disliked.has(song.videoId) &&
                    !usedAcrossMixes.has(song.videoId),
            );
            if (pool.length < MIN_TRACKS) return [];
            const artistNames = new Set(
                pool.map((song) => artistKey(song.artist)),
            );
            const familiarSongs = distinct(familiar).filter(
                (song) =>
                    artistNames.has(artistKey(song.artist)) &&
                    !disliked.has(song.videoId) &&
                    !usedAcrossMixes.has(song.videoId),
            );
            const familiarIds = new Set(
                familiarSongs.map((song) => song.videoId),
            );
            const newSongs = pool.filter(
                (song) => !familiarIds.has(song.videoId),
            );
            const fresh = mergeFamiliarAndNew(
                familiarSongs.filter((song) => !recentTimes.has(song.videoId)),
                newSongs.filter((song) => !recentTimes.has(song.videoId)),
            );
            const older = distinct([...familiarSongs, ...newSongs])
                .filter((song) => recentTimes.has(song.videoId))
                .sort(oldestPlayFirst);
            const tracks = [...fresh, ...older].slice(0, MAX_TRACKS);
            if (tracks.length < MIN_TRACKS) return [];
            for (const track of tracks) usedAcrossMixes.add(track.videoId);
            return [
                {
                    key: direction.key,
                    title:
                        direction.kind === "artist"
                            ? `${direction.label} и похожее`
                            : `${direction.label} для вас`,
                    description: "Знакомое и новые находки",
                    tracks: tracks.map(toTrack),
                },
            ];
        });
        return { mixes };
    }
}

function fromStoredTrack(track: {
    videoId: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    thumbnailUrl: string | null;
}): DailyMixSong {
    return { ...track };
}

export const personalDailyMixService = new PersonalDailyMixService({
    recordMixGeneration: async ({ userId, mix, generatedAt, latencyMs }) => {
        const day = generatedAt.toISOString().slice(0, 10);
        const generation = await prisma.recommendationGeneration.create({
            data: {
                userId,
                sessionId: `personal-daily:${day}:${mix.key}`,
                surface: "made-for-you",
                direction: "for-you",
                algorithm: "personal-daily-mix-v1",
                served: true,
                degradedSources: [],
                latencyMs,
                context: { dailyMix: { version: 1, key: mix.key, day } },
                exposures: {
                    create: mix.tracks.map((track, position) => ({
                        userId,
                        canonicalKey: `yt:${track.youtubeVideoId}`,
                        artistKey: normalizeRecommendationArtistKey(
                            track.artist.name,
                        ),
                        albumKey: buildRecommendationAlbumKey(
                            track.artist.name,
                            track.album.title,
                        ),
                        provider: "youtube",
                        providerTrackId: track.youtubeVideoId,
                        source: "personal-daily-mix",
                        position,
                    })),
                },
            },
            select: { id: true },
        });
        return generation.id;
    },
    loadDirections: async (userId) => {
        const settings = await prisma.userSettings.findUnique({
            where: { userId },
            select: { tasteProfile: true },
        });
        const profile = parseStoredTasteProfile(settings?.tasteProfile);
        const genres =
            profile?.genres.filter((genre) => tasteArtistTags[genre]) ?? [];
        return [
            ...genres.map((label) => ({
                key: `genre:${label}`,
                label,
                query: `${tasteArtistTags[label]} music`,
                kind: "genre" as const,
            })),
            ...(profile?.artists ?? []).map((label) => ({
                key: `artist:${label}`,
                label,
                query: `${label} songs`,
                kind: "artist" as const,
            })),
        ];
    },
    loadFamiliar: async (userId) => {
        const [liked, recent] = await Promise.all([
            prisma.likedRemoteTrack.findMany({
                where: { userId, trackYtMusicId: { not: null } },
                orderBy: { likedAt: "desc" },
                take: 80,
                select: {
                    trackYtMusic: {
                        select: {
                            videoId: true,
                            title: true,
                            artist: true,
                            album: true,
                            duration: true,
                            thumbnailUrl: true,
                        },
                    },
                },
            }),
            prisma.play.findMany({
                where: {
                    userId,
                    trackYtMusicId: { not: null },
                    OR: [
                        { outcome: { in: ["meaningful", "completed"] } },
                        { listenedSeconds: { gte: 240 } },
                        { completionRatio: { gte: 0.5 } },
                    ],
                },
                orderBy: { playedAt: "desc" },
                take: 80,
                select: {
                    trackYtMusic: {
                        select: {
                            videoId: true,
                            title: true,
                            artist: true,
                            album: true,
                            duration: true,
                            thumbnailUrl: true,
                        },
                    },
                },
            }),
        ]);
        return distinct(
            [...liked, ...recent].flatMap((row) =>
                row.trackYtMusic ? [fromStoredTrack(row.trackYtMusic)] : [],
            ),
        );
    },
    loadRecentlyPlayed: async (userId) => {
        const rows = await prisma.play.findMany({
            where: {
                userId,
                trackYtMusicId: { not: null },
                playedAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
            },
            orderBy: { playedAt: "desc" },
            take: 250,
            select: {
                playedAt: true,
                outcome: true,
                trackYtMusic: { select: { videoId: true } },
            },
        });
        return rows.flatMap((row) =>
            row.outcome !== "failed" && row.trackYtMusic
                ? [
                      {
                          videoId: row.trackYtMusic.videoId,
                          playedAt: row.playedAt,
                      },
                  ]
                : [],
        );
    },
    loadGenreArtists: async (genre) =>
        (await lastFmService.browseTasteArtists(genre, 1)).artists,
    searchSongs: async (userId, query) => {
        const result = await ytMusicService.searchCanonical(
            userId,
            query,
            "songs",
            8,
            { timeoutMs: 5_000, maxRetries: 0 },
        );
        return result.results.flatMap((song) =>
            song.providerTrackId && song.artistName
                ? [
                      {
                          videoId: song.providerTrackId,
                          title: song.title,
                          artist: song.artistName,
                          album: song.albumTitle ?? "Single",
                          duration: song.durationSec ?? 0,
                          thumbnailUrl: song.thumbnailUrl,
                      },
                  ]
                : [],
        );
    },
    getRadio: async (seedVideoId) => {
        const result = await ytMusicService.getRadio(seedVideoId, RADIO_LIMIT);
        return result.tracks.map((song) => ({
            videoId: song.videoId,
            title: song.title,
            artist: song.artist,
            album: song.album,
            duration: song.duration,
            thumbnailUrl: song.thumbnailUrl,
        }));
    },
    loadDislikedIds: async (userId, videoIds) => {
        if (videoIds.length === 0) return new Set();
        const rows = await prisma.dislikedEntity.findMany({
            where: {
                userId,
                entityType: "track",
                entityId: { in: videoIds.map((id) => `yt:${id}`) },
            },
            select: { entityId: true },
        });
        return new Set(rows.map((row) => row.entityId.slice(3)));
    },
    loadDislikeState: async (userId) => {
        const where = { userId, entityType: "track" };
        const [count, latest] = await Promise.all([
            prisma.dislikedEntity.count({ where }),
            prisma.dislikedEntity.findFirst({
                where,
                orderBy: [{ dislikedAt: "desc" }, { id: "desc" }],
                select: { id: true },
            }),
        ]);
        return `${count}:${latest?.id ?? "none"}`;
    },
    loadSuppressedArtistKeys: async (userId) => {
        // Match the catalog's bounded, active-dislike window. A single song
        // dislike is not an artist ban, and failed streams do not create one.
        const rows = await prisma.dislikedEntity.findMany({
            where: {
                userId,
                entityType: "track",
                entityId: { startsWith: "yt:" },
                dislikedAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
            },
            orderBy: { dislikedAt: "desc" },
            take: 100,
            select: { entityId: true },
        });
        const videoIds = [...new Set(rows.map((row) => row.entityId.slice(3)))];
        if (videoIds.length < 2) return new Set();
        const tracks = await prisma.trackYtMusic.findMany({
            where: { videoId: { in: videoIds } },
            select: { videoId: true, artist: true },
        });
        const dislikedVideosByArtist = new Map<string, Set<string>>();
        for (const track of tracks) {
            const key = artistKey(track.artist);
            if (!key || key === "unknown" || key === "unknown artist") continue;
            const videos = dislikedVideosByArtist.get(key) ?? new Set<string>();
            videos.add(track.videoId);
            dislikedVideosByArtist.set(key, videos);
        }
        return new Set(
            [...dislikedVideosByArtist].flatMap(([key, videos]) =>
                videos.size >= 2 ? [key] : [],
            ),
        );
    },
    now: () => new Date(),
});
