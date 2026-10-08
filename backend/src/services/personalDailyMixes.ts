import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { parseStoredTasteProfile } from "./tasteProfile";
import { tasteArtistTags } from "./tasteArtistGenres";
import { lastFmService } from "./lastfm";
import { ytMusicService } from "./youtubeMusic";
import type {
    PersonalizedTrack,
    PersonalizedNativeTrack,
} from "./personalizedCatalog";
import {
    personalNativeCandidateService,
    toNativePersonalizedTrack,
    type PersonalNativeCandidateService,
    type NativePersonalProfile,
} from "./recommendations/personalNativeCandidates";
import {
    hasNativeRecommendationIdentity,
    readNativeRecommendationRecording,
} from "./recommendations/nativeCandidates";
import { nativeArtistCreditKey } from "./recommendations/nativeSourceAdmission";
import type { RecommendationCandidate } from "./recommendations/types";
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
    /** Server-owned exact prepared native seed, never a provider artist API query. */
    nativeSeedId?: string;
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
    /** Native directions share the existing six composition slots. */
    nativeCandidates?: Pick<
        PersonalNativeCandidateService,
        "prepare" | "getBatch" | "admit"
    >;
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

type DailyMixCandidate = DailyMixSong | PersonalizedNativeTrack;
function songIdentity(song: DailyMixCandidate): string {
    return "source" in song ? song.id : song.videoId;
}
function songArtist(song: DailyMixCandidate): string {
    return typeof song.artist === "string" ? song.artist : song.artist.name;
}
function playable(song: DailyMixCandidate): boolean {
    if ("source" in song)
        return (
            !!readNativeRecommendationRecording(
                song as unknown as RecommendationCandidate,
            ) &&
            song.duration >= 45 &&
            song.duration <= 900
        );
    return (
        /^[A-Za-z0-9_-]{1,64}$/.test(song.videoId) &&
        song.title.trim().length > 0 &&
        song.artist.trim().length > 0 &&
        Number.isFinite(song.duration) &&
        song.duration >= 45 &&
        song.duration <= 900
    );
}

function distinct<T extends DailyMixCandidate>(songs: readonly T[]): T[] {
    const seen = new Set<string>();
    return songs.filter((song) => {
        if (!playable(song) || seen.has(songIdentity(song))) return false;
        seen.add(songIdentity(song));
        return true;
    });
}

function toTrack(song: DailyMixCandidate): PersonalizedTrack {
    if ("source" in song) return song;
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
    familiar: DailyMixCandidate[],
    newSongs: DailyMixCandidate[],
): DailyMixCandidate[] {
    const songs: DailyMixCandidate[] = [];
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
        const [
            directions,
            familiarSongs,
            dislikeState,
            suppressedArtists,
            nativeProfile,
        ] = await Promise.all([
            this.dependencies.loadDirections(userId),
            this.dependencies.loadFamiliar(userId),
            this.dependencies.loadDislikeState(userId),
            this.dependencies.loadSuppressedArtistKeys(userId),
            this.dependencies.nativeCandidates?.prepare(
                userId,
                this.dependencies.now(),
                { surface: "made-for-you" },
            ),
        ]);
        const familiar: DailyMixCandidate[] = [
            ...familiarSongs.filter(
                (song) => !suppressedArtists.has(artistKey(song.artist)),
            ),
            ...(nativeProfile
                ? [...nativeProfile.recent, ...nativeProfile.liked].flatMap(
                      (track) => toNativePersonalizedTrack(track) ?? [],
                  )
                : []),
        ];
        const seenArtists = new Set<string>();
        const familiarDirections: DailyMixDirection[] = familiarSongs.flatMap(
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
        const legacyDirections = [...directions, ...familiarDirections];
        const nativeDirections: DailyMixDirection[] = (
            nativeProfile?.seeds ?? []
        ).map((seed) => ({
            key: `native:${seed.id}`,
            label: seed.artist.name,
            query: "",
            kind: "artist",
            nativeSeedId: seed.id,
        }));
        const combinedDirections: DailyMixDirection[] = [];
        for (
            let i = 0;
            i < Math.max(legacyDirections.length, nativeDirections.length);
            i++
        ) {
            if (legacyDirections[i])
                combinedDirections.push(legacyDirections[i]);
            if (nativeDirections[i])
                combinedDirections.push(nativeDirections[i]);
        }
        const chosen = combinedDirections
            .filter((direction) => {
                if (
                    !direction.nativeSeedId &&
                    direction.kind === "artist" &&
                    suppressedArtists.has(artistKey(direction.label))
                )
                    return false;
                const key =
                    direction.nativeSeedId ??
                    `${direction.kind ?? "genre"}:${artistKey(direction.label)}`;
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
            familiar.map(songIdentity),
            ...(nativeProfile
                ? [
                      nativeProfile.plays.map((play) => [
                          play.track.id,
                          play.playedAt.getTime(),
                          play.outcome,
                      ]),
                  ]
                : []),
        ]);
        const cached = this.cache.get(key);
        if (cached && cached.expiresAt > now) {
            const composition = await cached.result;
            const nativeTracks = composition.mixes.flatMap((mix) =>
                mix.tracks.filter((track) => track.source !== "youtube"),
            );
            if (
                nativeTracks.length &&
                nativeProfile &&
                this.dependencies.nativeCandidates
            ) {
                const current = await this.dependencies.nativeCandidates.admit(
                    nativeProfile,
                    nativeTracks as unknown as RecommendationCandidate[],
                    false,
                );
                if (this.cache.get(key) !== cached)
                    return this.getMixes(userId);
                if (
                    current.fresh.length + current.fallback.length ===
                    nativeTracks.length
                )
                    return composition;
            } else return composition;
        }
        if (cached && this.cache.get(key) === cached) this.cache.delete(key);
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
                    nativeProfile,
                ),
            )
            .then(async ({ mixes, cacheable }) => {
                const served = await Promise.all(
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
                );
                if (!cacheable && this.cache.get(key)?.result === result)
                    this.cache.delete(key);
                return { mixes: served };
            });
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
        familiar: DailyMixCandidate[],
        recentlyPlayed: RecentlyPlayedSong[],
        suppressedArtists: ReadonlySet<string>,
        nativeProfile?: NativePersonalProfile,
    ): Promise<{ mixes: PersonalDailyMix[]; cacheable: boolean }> {
        let nativeDegraded = (nativeProfile?.degradedSources.length ?? 0) > 0;
        const allowedArtist = (song: DailyMixCandidate) =>
            "source" in song || !suppressedArtists.has(artistKey(song.artist));
        const recentTimes = new Map<string, number>();
        for (const play of recentlyPlayed) {
            const time = play.playedAt.getTime();
            if (!Number.isFinite(time)) continue;
            recentTimes.set(
                play.videoId,
                Math.max(recentTimes.get(play.videoId) ?? -Infinity, time),
            );
        }
        for (const play of nativeProfile?.plays ?? []) {
            if (
                play.outcome === "failed" ||
                play.playedAt.getTime() <
                    this.dependencies.now().getTime() - 7 * 86_400_000
            )
                continue;
            recentTimes.set(
                play.track.id,
                Math.max(
                    recentTimes.get(play.track.id) ?? -Infinity,
                    play.playedAt.getTime(),
                ),
            );
        }
        const nativeAllowed = new Set<string>(),
            nativeIdentities = new Map<string, string>();
        const compositionIdentity = (song: DailyMixCandidate) =>
            nativeIdentities.get(songIdentity(song)) ?? songIdentity(song);
        const hasFreshPool = (songs: DailyMixCandidate[]) =>
            distinct(songs).filter(
                (song) => !recentTimes.has(songIdentity(song)),
            ).length >= MAX_TRACKS;
        const pools: DailyMixCandidate[][] = [];
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
                            if (
                                direction.nativeSeedId &&
                                nativeProfile &&
                                this.dependencies.nativeCandidates
                            ) {
                                const seed = nativeProfile.seeds.find(
                                    (track) =>
                                        track.id === direction.nativeSeedId,
                                );
                                if (!seed) return [];
                                const batch =
                                    await this.dependencies.nativeCandidates.getBatch(
                                        nativeProfile,
                                        [seed],
                                    );
                                if (batch.degradedSources.length)
                                    nativeDegraded = true;
                                const rows = [
                                    ...batch.fresh,
                                    ...batch.fallback,
                                ].filter(
                                    (track) =>
                                        track.lane === "discovery" ||
                                        nativeArtistCreditKey(
                                            track.musicSourceRecording,
                                        ) ===
                                            nativeArtistCreditKey(
                                                seed.musicSourceRecording,
                                            ),
                                );
                                for (const track of rows) {
                                    nativeAllowed.add(track.id);
                                    nativeIdentities.set(
                                        track.id,
                                        track.canonicalRecordingId
                                            ? `canonical:${track.canonicalRecordingId}`
                                            : track.id,
                                    );
                                }
                                return rows.flatMap(
                                    (track) =>
                                        toNativePersonalizedTrack(track) ?? [],
                                );
                            }
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
                                familiar.map((song) =>
                                    artistKey(songArtist(song)),
                                ),
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
                            const songs: DailyMixCandidate[] = [];
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
                                                  artistKey(
                                                      songArtist(song),
                                                  ) === artistKey(artist),
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
                                                    songIdentity(seed),
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
                            if (direction.nativeSeedId) nativeDegraded = true;
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
                [...pools.flat(), ...familiar]
                    .filter((song) => !("source" in song))
                    .map(songIdentity),
            ),
        ];
        const disliked = await this.dependencies.loadDislikedIds(
            userId,
            allIds,
        );
        const oldestPlayFirst = (
            left: DailyMixCandidate,
            right: DailyMixCandidate,
        ) =>
            (recentTimes.get(songIdentity(left)) ?? 0) -
            (recentTimes.get(songIdentity(right)) ?? 0);
        const usedAcrossMixes = new Set<string>();
        const mixes = chosen.flatMap((direction, index) => {
            const pool = pools[index].filter(
                (song) =>
                    !disliked.has(songIdentity(song)) &&
                    !usedAcrossMixes.has(compositionIdentity(song)),
            );
            if (pool.length < MIN_TRACKS) return [];
            const artistNames = new Set(
                pool.map((song) => artistKey(songArtist(song))),
            );
            const familiarSongs = distinct(familiar).filter(
                (song) =>
                    artistNames.has(artistKey(songArtist(song))) &&
                    (!("source" in song) ||
                        (!!direction.nativeSeedId &&
                            nativeAllowed.has(song.id))) &&
                    !disliked.has(songIdentity(song)) &&
                    !usedAcrossMixes.has(compositionIdentity(song)),
            );
            const familiarIds = new Set(familiarSongs.map(songIdentity));
            const newSongs = pool.filter(
                (song) => !familiarIds.has(songIdentity(song)),
            );
            const fresh = mergeFamiliarAndNew(
                familiarSongs.filter(
                    (song) => !recentTimes.has(songIdentity(song)),
                ),
                newSongs.filter((song) => !recentTimes.has(songIdentity(song))),
            );
            const older = distinct([...familiarSongs, ...newSongs])
                .filter((song) => recentTimes.has(songIdentity(song)))
                .sort(oldestPlayFirst);
            const tracks = [...fresh, ...older].slice(0, MAX_TRACKS);
            if (tracks.length < MIN_TRACKS) return [];
            for (const track of tracks)
                usedAcrossMixes.add(compositionIdentity(track));
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
        return { mixes, cacheable: !nativeDegraded };
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
    nativeCandidates: personalNativeCandidateService,
    recordMixGeneration: async ({ userId, mix, generatedAt, latencyMs }) => {
        for (const track of mix.tracks) {
            const candidate = track as unknown as RecommendationCandidate;
            if (
                hasNativeRecommendationIdentity(candidate) &&
                !readNativeRecommendationRecording(candidate)
            )
                throw new TypeError("Invalid native daily mix identity");
        }
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
                        canonicalKey:
                            track.source === "youtube"
                                ? `yt:${track.youtubeVideoId}`
                                : `provider:${track.id}`,
                        artistKey: normalizeRecommendationArtistKey(
                            track.artist.name,
                        ),
                        albumKey: buildRecommendationAlbumKey(
                            track.artist.name,
                            track.album.title,
                        ),
                        provider: track.source,
                        providerTrackId:
                            track.source === "youtube"
                                ? track.youtubeVideoId
                                : track.provider.providerTrackId,
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
