import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    personalizedCatalogService,
    songRepeatKey,
} from "./personalizedCatalog";
import {
    loadDislikedYouTubeIds,
    loadSuppressedYouTubeArtists,
} from "./personalizedTrackPreferences";
import { parseStoredTasteProfile } from "./tasteProfile";
import {
    PrismaWeeklyDiscoveryStore,
    weeklyDiscoveryTrackSchema,
    type WeeklyDiscoveryStorage,
    type WeeklyDiscoveryTrack,
    type StoredWeeklyDiscovery,
    weeklyDiscoveryTrackIdentity,
} from "./weeklyDiscoveryStore";
import {
    personalNativeCandidateService,
    loadKnownNativePersonalIds,
} from "./recommendations/personalNativeCandidates";
import { toNativeRecommendationCandidate } from "./recommendations/nativeCandidates";
import { nativeArtistCreditKey } from "./recommendations/nativeSourceAdmission";

const log = logger.child("PersonalWeeklyDiscovery");
const TARGET_TRACKS = 40;
const MIN_TRACKS = 20;
const GENERATION_TIMEOUT_MS = 12_000;

/** Testable boundaries for weekly persistence, candidates and user feedback. */
export interface PersonalWeeklyDiscoveryDependencies {
    store: WeeklyDiscoveryStorage;
    getCandidates(
        userId: string,
        cursor: number,
        excludedVideoIds: string[],
    ): Promise<WeeklyDiscoveryTrack[]>;
    loadNoveltyExclusions(
        userId: string,
        candidates: WeeklyDiscoveryTrack[],
    ): Promise<Set<string>>;
    loadDislikedIds(userId: string, videoIds: string[]): Promise<Set<string>>;
    loadSuppressedArtistKeys(userId: string): Promise<Set<string>>;
    now(): Date;
    /** Fresh exact native feedback on finite candidates; saved week reads retain their stable listening order. */
    filterNativeCandidates?(
        userId: string,
        tracks: WeeklyDiscoveryTrack[],
    ): Promise<WeeklyDiscoveryTrack[]>;
}

/** Current-week online playlist with owned generation attribution. */
export interface WeeklyDiscoveryPlaylist {
    kind: "online-weekly";
    weekStart: Date;
    weekEnd: Date;
    generationId?: string;
    tracks: Array<
        WeeklyDiscoveryTrack & { recommendationGenerationId: string }
    >;
    unavailable: never[];
    totalCount: number;
    count: number;
    unavailableCount: number;
}

function weekStart(now: Date): string {
    const date = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString();
}
function artistKey(artist: string): string {
    return artist.trim().toLocaleLowerCase("en-US");
}

/** Stable weekly discoveries: familiarity is checked on creation, feedback on every read. */
export class PersonalWeeklyDiscoveryService {
    private readonly pending = new Map<
        string,
        Promise<StoredWeeklyDiscovery | null>
    >();
    constructor(
        private readonly dependencies: PersonalWeeklyDiscoveryDependencies,
    ) {}

    /** Read or create the account's week, without reranking a saved playlist. */
    async getCurrent(userId: string): Promise<WeeklyDiscoveryPlaylist> {
        if (!userId.trim()) throw new TypeError("A user id is required");
        const week = weekStart(this.dependencies.now());
        // Read persisted state before joining only an unfinished generation.
        // Another API process can have cleared the week since our pending read.
        let saved = await this.dependencies.store.find(userId, week);
        if (!saved) {
            const key = JSON.stringify([userId, week]);
            let pending = this.pending.get(key);
            if (!pending) {
                pending = this.loadOrGenerate(userId, week);
                this.pending.set(key, pending);
            }
            try {
                saved = await pending;
            } finally {
                if (this.pending.get(key) === pending) this.pending.delete(key);
            }
        }
        let tracks: WeeklyDiscoveryPlaylist["tracks"] = [];
        if (saved && !saved.cleared) {
            const [disliked, suppressed] = await Promise.all([
                this.dependencies.loadDislikedIds(
                    userId,
                    saved.tracks
                        .filter((t) => t.sourceType === "youtube")
                        .map(weeklyDiscoveryTrackIdentity),
                ),
                this.dependencies.loadSuppressedArtistKeys(userId),
            ]);
            const current = this.dependencies.filterNativeCandidates
                ? await this.dependencies.filterNativeCandidates(
                      userId,
                      saved.tracks,
                  )
                : saved.tracks;
            tracks = current
                .filter(
                    (t) =>
                        t.sourceType !== "youtube" ||
                        (!disliked.has(t.youtubeVideoId) &&
                            !suppressed.has(artistKey(t.artist))),
                )
                .map((t) => ({ ...t, recommendationGenerationId: saved.id }));
        }
        return {
            kind: "online-weekly",
            weekStart: new Date(week),
            weekEnd: new Date(Date.parse(week) + 7 * 86_400_000 - 1),
            ...(saved ? { generationId: saved.id } : {}),
            tracks,
            unavailable: [],
            totalCount: tracks.length,
            count: tracks.length,
            unavailableCount: 0,
        };
    }

    /** Explicitly clear this week, including a not-yet-generated playlist. */
    async clearCurrent(userId: string): Promise<number> {
        if (!userId.trim()) throw new TypeError("A user id is required");
        const week = weekStart(this.dependencies.now());
        const count = await this.dependencies.store.clear(userId, week);
        this.pending.delete(JSON.stringify([userId, week]));
        return count;
    }

    private async loadOrGenerate(
        userId: string,
        week: string,
    ): Promise<StoredWeeklyDiscovery | null> {
        const existing = await this.dependencies.store.find(userId, week);
        if (existing) return existing;
        let expired = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const started = Date.now();
        try {
            const tracks = await Promise.race([
                this.collect(userId, () => expired),
                new Promise<null>((resolve) => {
                    timer = setTimeout(() => {
                        expired = true;
                        resolve(null);
                    }, GENERATION_TIMEOUT_MS);
                }),
            ]);
            if (!tracks || tracks.length < MIN_TRACKS) return null;
            return await this.dependencies.store.save(
                userId,
                week,
                tracks,
                Date.now() - started,
            );
        } catch (error) {
            log.warn(
                "Weekly candidate generation unavailable",
                { userId },
                error,
            );
            return null;
        } finally {
            expired = true;
            if (timer) clearTimeout(timer);
        }
    }

    private async collect(
        userId: string,
        expired: () => boolean,
    ): Promise<WeeklyDiscoveryTrack[]> {
        const pool: WeeklyDiscoveryTrack[] = [];
        let selected: WeeklyDiscoveryTrack[] = [];
        for (let cursor = 0; cursor < 2 && !expired(); cursor++) {
            const candidates = await this.dependencies.getCandidates(
                userId,
                cursor,
                pool.map(weeklyDiscoveryTrackIdentity),
            );
            if (expired()) return [];
            for (const candidate of candidates.slice(0, TARGET_TRACKS)) {
                const parsed = weeklyDiscoveryTrackSchema.safeParse(candidate);
                if (
                    parsed.success &&
                    songRepeatKey(parsed.data.artist, parsed.data.title)
                )
                    pool.push(parsed.data);
            }
            const [known, disliked, suppressed] = await Promise.all([
                this.dependencies.loadNoveltyExclusions(userId, pool),
                this.dependencies.loadDislikedIds(
                    userId,
                    pool
                        .filter((t) => t.sourceType === "youtube")
                        .map(weeklyDiscoveryTrackIdentity),
                ),
                this.dependencies.loadSuppressedArtistKeys(userId),
            ]);
            if (expired()) return [];
            const current = this.dependencies.filterNativeCandidates
                ? await this.dependencies.filterNativeCandidates(userId, pool)
                : pool;
            if (expired()) return [];
            const ids = new Set<string>();
            const recordings = new Set<string>();
            const artists = new Map<string, number>();
            selected = current
                .filter((track) => {
                    const identity = weeklyDiscoveryTrackIdentity(track);
                    const key =
                        track.sourceType === "youtube"
                            ? songRepeatKey(track.artist, track.title)
                            : track.id;
                    const artist =
                        track.sourceType === "youtube"
                            ? artistKey(track.artist)
                            : nativeArtistCreditKey(
                                  track.musicSourceRecording,
                              )!;
                    if (
                        !key ||
                        known.has(identity) ||
                        (track.sourceType === "youtube" &&
                            (disliked.has(identity) ||
                                suppressed.has(artist))) ||
                        ids.has(identity) ||
                        recordings.has(key) ||
                        (artists.get(artist) ?? 0) >= 2
                    )
                        return false;
                    ids.add(identity);
                    recordings.add(key);
                    artists.set(artist, (artists.get(artist) ?? 0) + 1);
                    return true;
                })
                .slice(0, TARGET_TRACKS);
            if (selected.length === TARGET_TRACKS) break;
        }
        return selected;
    }
}

/** Candidate-scoped history lookup includes old plays without scanning all user history. */
export async function loadWeeklyNoveltyExclusions(
    userId: string,
    candidates: WeeklyDiscoveryTrack[],
): Promise<Set<string>> {
    if (candidates.length === 0) return new Set();
    const native = candidates.flatMap((track) =>
        track.sourceType === "youtube"
            ? []
            : (toNativeRecommendationCandidate(
                  track.musicSourceRecording,
                  "weekly-novelty",
              ) ?? []),
    );
    const nativeKnown = await loadKnownNativePersonalIds(
        userId,
        native,
        new Date(),
        () => {},
    );
    const youtube = candidates.filter(
        (
            track,
        ): track is Extract<WeeklyDiscoveryTrack, { sourceType: "youtube" }> =>
            track.sourceType === "youtube",
    );
    if (!youtube.length) return nativeKnown;
    // Query a bounded set of metadata tokens, then compare the full normalized
    // recording key. Exact SQL equality misses punctuation variants with new IDs.
    const tokens = (value: string) =>
        [
            ...new Set(
                value
                    .normalize("NFKC")
                    .toLocaleLowerCase("en-US")
                    .match(/[\p{L}\p{N}]+/gu) ?? [],
            ),
        ]
            .sort((a, b) => b.length - a.length)
            .slice(0, 3);
    const identity = {
        OR: [
            { videoId: { in: youtube.map((t) => t.youtubeVideoId) } },
            ...youtube.flatMap((t) => {
                const titleTokens = tokens(t.title);
                const artistTokens = tokens(t.artist);
                return titleTokens.length && artistTokens.length
                    ? [
                          {
                              AND: [
                                  ...titleTokens.map((token) => ({
                                      title: {
                                          contains: token,
                                          mode: "insensitive" as const,
                                      },
                                  })),
                                  ...artistTokens.map((token) => ({
                                      artist: {
                                          contains: token,
                                          mode: "insensitive" as const,
                                      },
                                  })),
                              ],
                          },
                      ]
                    : [];
            }),
        ],
    };
    const select = { videoId: true, title: true, artist: true };
    const [plays, likes, settings] = await Promise.all([
        prisma.play.findMany({
            where: {
                userId,
                trackYtMusic: identity,
                OR: [{ outcome: null }, { outcome: { not: "failed" } }],
            },
            distinct: ["trackYtMusicId"],
            select: { trackYtMusic: { select } },
        }),
        prisma.likedRemoteTrack.findMany({
            where: { userId, trackYtMusic: identity },
            select: { trackYtMusic: { select } },
        }),
        prisma.userSettings.findUnique({
            where: { userId },
            select: { tasteProfile: true },
        }),
    ]);
    const known = [
        ...plays.flatMap((row) => (row.trackYtMusic ? [row.trackYtMusic] : [])),
        ...likes.flatMap((row) => (row.trackYtMusic ? [row.trackYtMusic] : [])),
        ...(
            parseStoredTasteProfile(settings?.tasteProfile)?.seedTracks ?? []
        ).map((t) => ({ ...t, videoId: t.videoId })),
    ];
    const ids = new Set(known.map((t) => t.videoId));
    const keys = new Set(
        known
            .map((t) => songRepeatKey(t.artist, t.title))
            .filter((key): key is string => key !== null),
    );
    return new Set([
        ...nativeKnown,
        ...youtube
            .filter(
                (t) =>
                    ids.has(t.youtubeVideoId) ||
                    keys.has(songRepeatKey(t.artist, t.title) ?? ""),
            )
            .map((t) => t.youtubeVideoId),
    ]);
}

/** Production DI for online weekly discovery metadata; no audio is downloaded. */
export const personalWeeklyDiscoveryService =
    new PersonalWeeklyDiscoveryService({
        store: new PrismaWeeklyDiscoveryStore(prisma),
        getCandidates: async (userId, cursor, excludeVideoIds) => {
            const feed = await personalizedCatalogService.getHomeFeed(
                userId,
                TARGET_TRACKS,
                { surface: "weekly", mode: "new", cursor, excludeVideoIds },
            );
            return feed.shelves.discovery.flatMap((t) => {
                const parsed = weeklyDiscoveryTrackSchema.safeParse({
                    id: t.id,
                    ...(t.source === "youtube"
                        ? { youtubeVideoId: t.youtubeVideoId }
                        : {
                              musicSourceRecording: t.musicSourceRecording,
                              provider: t.provider,
                          }),
                    title: t.title,
                    artist: t.artist.name,
                    album: t.album.title,
                    albumId: t.album.id ?? t.id,
                    duration: t.duration,
                    coverUrl: t.album.coverArt || null,
                    sourceType: t.source,
                    streamSource: t.streamSource,
                    available: true,
                    isLiked: false,
                    likedAt: null,
                    similarity: 0,
                    tier: "explore",
                });
                return parsed.success ? [parsed.data] : [];
            });
        },
        loadNoveltyExclusions: loadWeeklyNoveltyExclusions,
        loadDislikedIds: loadDislikedYouTubeIds,
        loadSuppressedArtistKeys: loadSuppressedYouTubeArtists,
        filterNativeCandidates: async (userId, tracks) => {
            const candidates = tracks.flatMap((track) =>
                track.sourceType === "youtube"
                    ? []
                    : (toNativeRecommendationCandidate(
                          track.musicSourceRecording,
                          "weekly-feedback",
                      ) ?? []),
            );
            if (!candidates.length) return tracks;
            const batch = await personalNativeCandidateService.admit(
                {
                    userId,
                    policyTime: new Date(),
                    options: { surface: "home" },
                    recent: [],
                    liked: [],
                    plays: [],
                    knownIds: new Set(),
                    seeds: [],
                    degradedSources: [],
                },
                candidates,
            );
            const allowed = new Set(batch.fresh.map((track) => track.id));
            return tracks.filter(
                (track) =>
                    track.sourceType === "youtube" || allowed.has(track.id),
            );
        },
        now: () => new Date(),
    });
