jest.mock("../youtubeMusic", () => ({ ytMusicService: {} }));
jest.mock("../lastfm", () => ({ lastFmService: {} }));
jest.mock("../tasteProfile", () => ({ parseStoredTasteProfile: jest.fn() }));
jest.mock("../../utils/db", () => ({
    prisma: {
        userSettings: { findUnique: jest.fn() },
        play: { findMany: jest.fn() },
        dislikedEntity: { findMany: jest.fn() },
        trackYtMusic: { findMany: jest.fn() },
    },
}));
jest.mock("../../utils/logger", () => {
    const logger = { warn: jest.fn(), child: jest.fn() };
    logger.child.mockReturnValue(logger);
    return { logger };
});

import {
    PersonalDailyMixService,
    personalDailyMixService,
    type PersonalDailyMixDependencies,
    type RecordDailyMixGenerationInput,
} from "../personalDailyMixes";
import { prisma } from "../../utils/db";
import { parseStoredTasteProfile } from "../tasteProfile";

const song = (id: string, artist: string) => ({
    videoId: id,
    title: `Song ${id}`,
    artist,
    album: "Album",
    duration: 180,
    thumbnailUrl: `https://example.com/${id}.jpg`,
});

const radio = (prefix: string, artist: string) =>
    Array.from({ length: 48 }, (_, index) =>
        song(`${prefix}-${index}`, `${artist} ${index % 6}`),
    );

function dependencies(
    overrides: Partial<PersonalDailyMixDependencies> = {},
): PersonalDailyMixDependencies {
    return {
        loadDirections: async () => [
            { key: "rock", label: "Рок", query: "rock music" },
            { key: "jazz", label: "Джаз", query: "jazz music" },
        ],
        loadFamiliar: async () => [song("favorite-rock", "Rock Artist 1")],
        loadRecentlyPlayed: async () => [],
        loadGenreArtists: async () => [],
        searchSongs: async (_userId, query) => [
            song(`${query.split(" ")[0]}-seed`, `${query} Artist`),
        ],
        getRadio: async (videoId) =>
            radio(videoId.split("-")[0], videoId.split("-")[0]),
        loadDislikedIds: async () => new Set<string>(),
        loadDislikeState: async () => "none",
        loadSuppressedArtistKeys: async () => new Set<string>(),
        recordMixGeneration: async ({ userId, mix }) =>
            `test:${userId}:${mix.key}`,
        now: () => new Date("2026-09-26T08:00:00Z"),
        ...overrides,
    };
}

describe("PersonalDailyMixService", () => {
    it("retains newer cached attribution when an expired pending request fails", async () => {
        let now = new Date("2026-10-07T08:00:00Z");
        let rejectOld!: (error: Error) => void;
        let entered!: () => void;
        const oldPending = new Promise<Set<string>>((_resolve, reject) => {
            rejectOld = reject;
        });
        const oldEntered = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let reads = 0;
        let writes = 0;
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                loadFamiliar: async () => [],
                loadDislikedIds: async () => {
                    if (++reads === 1) {
                        entered();
                        return oldPending;
                    }
                    return new Set();
                },
                recordMixGeneration: async () => `generation-${++writes}`,
                now: () => now,
            }),
        );
        const oldFailure = expect(service.getMixes("listener")).rejects.toThrow(
            "old request failed",
        );
        await oldEntered;
        now = new Date("2026-10-07T08:11:00Z");
        const replacement = await service.getMixes("listener");
        rejectOld(new Error("old request failed"));
        await oldFailure;
        const cached = await service.getMixes("listener");
        expect(cached.mixes[0].generationId).toBe(
            replacement.mixes[0].generationId,
        );
        expect(writes).toBe(1);
    });

    it("keeps one owned generation for concurrent reads of the same cached mix", async () => {
        const saved: RecordDailyMixGenerationInput[] = [];
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                loadFamiliar: async () => [],
                recordMixGeneration: async (input) => {
                    saved.push(input);
                    return `owned-${input.userId}-${saved.length}`;
                },
            }),
        );
        const results = await Promise.all(
            Array.from({ length: 5 }, () => service.getMixes("listener")),
        );
        expect(results.map((r) => r.mixes[0].generationId)).toEqual(
            Array(5).fill("owned-listener-1"),
        );
        expect(saved).toHaveLength(1);
        expect(saved[0].userId).toBe("listener");
        expect(saved[0].mix.key).toBe("rock");
        expect(saved[0].mix.tracks).toEqual(results[0].mixes[0].tracks);
        const other = await service.getMixes("another");
        expect(other.mixes[0].generationId).toBe("owned-another-2");
    });

    it("replaces attribution after dislikes change the cached composition", async () => {
        let dislikeState = "none";
        let writes = 0;
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                loadFamiliar: async () => [],
                loadDislikeState: async () => dislikeState,
                loadDislikedIds: async () =>
                    new Set(dislikeState === "none" ? [] : ["rock-seed"]),
                recordMixGeneration: async () => `generation-${++writes}`,
            }),
        );
        const first = await service.getMixes("listener");
        dislikeState = "changed";
        const second = await service.getMixes("listener");
        expect(first.mixes[0].generationId).toBe("generation-1");
        expect(second.mixes[0].generationId).toBe("generation-2");
        expect(
            second.mixes[0].tracks.map((t) => t.youtubeVideoId),
        ).not.toContain("rock-seed");
    });

    it("keeps playback available without invented lineage when recording fails", async () => {
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                loadFamiliar: async () => [],
                recordMixGeneration: async () => {
                    throw new Error("DB unavailable");
                },
            }),
        );
        const result = await service.getMixes("listener");
        expect(result.mixes[0].tracks).toHaveLength(40);
        expect(result.mixes[0].generationId).toBeUndefined();
    });

    it("continues the bounded seed search when the first pool contains many recent plays", async () => {
        const getRadio = jest.fn(async (id: string) =>
            Array.from({ length: 40 }, (_, i) =>
                song(`${id}-${i}`, `Artist ${i % 10}`),
            ),
        );
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    {
                        key: "artist",
                        label: "Artist",
                        query: "artist music",
                        kind: "artist",
                    },
                ],
                loadFamiliar: async () => [],
                loadRecentlyPlayed: async () =>
                    Array.from({ length: 21 }, (_, i) => ({
                        videoId: `first-${i}`,
                        playedAt: new Date("2026-09-25T08:00:00Z"),
                    })),
                searchSongs: async () => [
                    song("first", "Artist"),
                    song("second", "Artist"),
                ],
                getRadio,
            }),
        );
        const result = await service.getMixes("listener");
        expect(result.mixes[0].tracks).toHaveLength(40);
        expect(getRadio).toHaveBeenCalledTimes(2);
        expect(
            result.mixes[0].tracks.some((t) =>
                /^first-(?:[0-9]|1[0-9]|20)$/.test(t.youtubeVideoId),
            ),
        ).toBe(false);
    });
    it("does not confuse one artist containing a separator with two suppressed artists", async () => {
        let suppressed = new Set(["alpha|beta"]);
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                loadFamiliar: async () => [],
                loadSuppressedArtistKeys: async () => suppressed,
                getRadio: async () => [
                    song("alpha", "Alpha"),
                    song("beta", "Beta"),
                    ...radio("safe", "Safe"),
                ],
            }),
        );
        const first = await service.getMixes("user-1");
        expect(
            first.mixes[0].tracks.some(
                (track) => track.artist.name === "Alpha",
            ),
        ).toBe(true);
        suppressed = new Set(["alpha", "beta"]);

        const second = await service.getMixes("user-1");

        expect(second.mixes[0].tracks).toHaveLength(40);
        expect(
            second.mixes[0].tracks.some((track) =>
                ["Alpha", "Beta"].includes(track.artist.name),
            ),
        ).toBe(false);
    });

    it("suppresses only artists with two distinct current dislikes from this account", async () => {
        jest.mocked(prisma.dislikedEntity.findMany).mockResolvedValueOnce([
            { entityId: "yt:first" },
            { entityId: "yt:second" },
            { entityId: "yt:single" },
            { entityId: "yt:duplicate" },
        ] as never);
        jest.mocked(prisma.trackYtMusic.findMany).mockResolvedValueOnce([
            { videoId: "first", artist: " Ibrahim Maalouf " },
            { videoId: "second", artist: "IBRAHIM MAALOUF" },
            { videoId: "single", artist: "Single Artist" },
            { videoId: "duplicate", artist: "Single Artist" },
            { videoId: "duplicate", artist: "Single Artist" },
        ] as never);
        const liveDependencies = (
            personalDailyMixService as unknown as {
                dependencies: PersonalDailyMixDependencies;
            }
        ).dependencies;

        const result =
            await liveDependencies.loadSuppressedArtistKeys("user-1");

        expect(result).toEqual(new Set(["ibrahim maalouf", "single artist"]));
        expect(prisma.dislikedEntity.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    userId: "user-1",
                    entityType: "track",
                    entityId: { startsWith: "yt:" },
                    dislikedAt: { gte: expect.any(Date) },
                }),
                take: 100,
            }),
        );
    });

    it("does not suppress one disliked song, missing metadata, or unknown artists", async () => {
        jest.mocked(prisma.dislikedEntity.findMany).mockResolvedValueOnce([
            { entityId: "yt:single" },
            { entityId: "yt:missing" },
            { entityId: "yt:unknown1" },
            { entityId: "yt:unknown2" },
        ] as never);
        jest.mocked(prisma.trackYtMusic.findMany).mockResolvedValueOnce([
            { videoId: "single", artist: "Single Artist" },
            { videoId: "single", artist: "Single Artist" },
            { videoId: "unknown1", artist: "Unknown Artist" },
            { videoId: "unknown2", artist: "Unknown Artist" },
        ] as never);
        const liveDependencies = (
            personalDailyMixService as unknown as {
                dependencies: PersonalDailyMixDependencies;
            }
        ).dependencies;
        expect(
            await liveDependencies.loadSuppressedArtistKeys("user-1"),
        ).toEqual(new Set());
    });

    it("excludes a suppressed artist from daily radio and familiar songs", async () => {
        const service = new PersonalDailyMixService(
            Object.assign(
                dependencies({
                    loadDirections: async () => [
                        { key: "jazz", label: "Джаз", query: "jazz music" },
                    ],
                    loadFamiliar: async () => [
                        song("known-blocked", "Ibrahim Maalouf"),
                    ],
                    getRadio: async () => [
                        ...radio("blocked", "Ibrahim Maalouf").map((track) => ({
                            ...track,
                            artist: "Ibrahim Maalouf",
                        })),
                        ...radio("fresh", "Jazz Artist"),
                    ],
                }),
                {
                    loadSuppressedArtistKeys: async () =>
                        new Set(["ibrahim maalouf"]),
                },
            ),
        );

        const result = await service.getMixes("user-1");

        expect(result.mixes).toHaveLength(1);
        expect(result.mixes[0].tracks).toHaveLength(40);
        expect(
            result.mixes[0].tracks.some(
                (track) =>
                    track.artist.name.toLowerCase() === "ibrahim maalouf",
            ),
        ).toBe(false);
    });

    it("does not use a suppressed selected or familiar artist as a direction or genre seed", async () => {
        const searchSongs = jest.fn(async (_userId: string, query: string) => [
            song(`${query.split(" ")[0]}-seed`, query.split(" songs")[0]),
        ]);
        const service = new PersonalDailyMixService(
            Object.assign(
                dependencies({
                    loadDirections: async () => [
                        {
                            key: "artist:Muse",
                            label: "Muse",
                            query: "Muse songs",
                            kind: "artist",
                        },
                        {
                            key: "rock",
                            label: "Рок",
                            query: "rock music",
                            kind: "genre",
                        },
                    ],
                    loadFamiliar: async () => [song("liked-muse", "muse")],
                    loadGenreArtists: async () => ["Muse", "Radiohead"],
                    searchSongs,
                    getRadio: async () => radio("rock", "Radiohead"),
                }),
                { loadSuppressedArtistKeys: async () => new Set(["muse"]) },
            ),
        );

        const result = await service.getMixes("user-1");

        expect(result.mixes.map((mix) => mix.title)).toEqual(["Рок для вас"]);
        expect(searchSongs).not.toHaveBeenCalledWith("user-1", "Muse songs");
        expect(searchSongs).toHaveBeenCalledWith("user-1", "Radiohead songs");
    });

    it("rechecks artist suppression on cache hits and when the suppression expires", async () => {
        let suppressed = new Set<string>();
        const getRadio = jest.fn(async () => [
            ...Array.from({ length: 5 }, (_, i) =>
                song(`blocked-${i}`, "Blocked Artist"),
            ),
            ...radio("safe", "Safe Artist"),
        ]);
        const service = new PersonalDailyMixService(
            Object.assign(
                dependencies({
                    loadDirections: async () => [
                        { key: "rock", label: "Рок", query: "rock music" },
                    ],
                    loadFamiliar: async () => [],
                    getRadio,
                }),
                { loadSuppressedArtistKeys: async () => suppressed },
            ),
        );

        const original = await service.getMixes("user-1");
        expect(
            original.mixes[0].tracks.some(
                (track) => track.artist.name === "Blocked Artist",
            ),
        ).toBe(true);
        suppressed = new Set(["blocked artist"]);
        const blocked = await service.getMixes("user-1");
        expect(
            blocked.mixes[0].tracks.some(
                (track) => track.artist.name === "Blocked Artist",
            ),
        ).toBe(false);
        suppressed = new Set();
        const expired = await service.getMixes("user-1");
        expect(
            expired.mixes[0].tracks.some(
                (track) => track.artist.name === "Blocked Artist",
            ),
        ).toBe(true);
    });

    it("loads only this account's playable recent history and ignores failed streams", async () => {
        const playedAt = new Date("2026-09-26T07:00:00Z");
        jest.mocked(prisma.play.findMany).mockResolvedValueOnce([
            {
                playedAt,
                outcome: "completed",
                trackYtMusic: { videoId: "played" },
            },
            {
                playedAt,
                outcome: "failed",
                trackYtMusic: { videoId: "failed" },
            },
            { playedAt, outcome: "skipped", trackYtMusic: null },
        ] as never);
        const liveDependencies = (
            personalDailyMixService as unknown as {
                dependencies: PersonalDailyMixDependencies;
            }
        ).dependencies;

        expect(await liveDependencies.loadRecentlyPlayed("user-1")).toEqual([
            { videoId: "played", playedAt },
        ]);
        expect(prisma.play.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ userId: "user-1" }),
                take: 250,
            }),
        );
    });

    it("includes explicitly selected artists alongside selected genres", async () => {
        jest.mocked(prisma.userSettings.findUnique).mockResolvedValueOnce({
            tasteProfile: {},
        } as never);
        jest.mocked(parseStoredTasteProfile).mockReturnValueOnce({
            genres: ["Рок"],
            artists: ["Muse"],
            seedTracks: [],
        });
        const liveDependencies = (
            personalDailyMixService as unknown as {
                dependencies: PersonalDailyMixDependencies;
            }
        ).dependencies;

        expect(await liveDependencies.loadDirections("user-1")).toEqual([
            {
                key: "genre:Рок",
                label: "Рок",
                query: expect.stringContaining("music"),
                kind: "genre",
            },
            {
                key: "artist:Muse",
                label: "Muse",
                query: "Muse songs",
                kind: "artist",
            },
        ]);
    });

    it("offers up to six distinct directions when the account has varied tastes", async () => {
        const labels = ["Рок", "Джаз", "Соул", "Хаус", "Фолк", "Метал", "Поп"];
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () =>
                    labels.map((label, index) => ({
                        key: `genre:${index}`,
                        label,
                        query: `style${index} music`,
                        kind: "genre" as const,
                    })),
                loadFamiliar: async () => [],
                getRadio: async (videoId) =>
                    radio(videoId.split("-")[0], videoId.split("-")[0]),
            }),
        );

        const result = await service.getMixes("user-1");

        expect(result.mixes.map((mix) => mix.title)).toEqual(
            labels.slice(0, 6).map((label) => `${label} для вас`),
        );
        expect(result.mixes.every((mix) => mix.tracks.length >= 20)).toBe(true);
    });

    it("keeps provider searches at the former three-direction concurrency", async () => {
        let activeSearches = 0;
        let peakSearches = 0;
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () =>
                    Array.from({ length: 6 }, (_, index) => ({
                        key: `genre:${index}`,
                        label: `Style ${index}`,
                        query: `style${index} music`,
                        kind: "genre" as const,
                    })),
                loadFamiliar: async () => [],
                searchSongs: async (_userId, query) => {
                    activeSearches += 1;
                    peakSearches = Math.max(peakSearches, activeSearches);
                    await new Promise((resolve) => setTimeout(resolve, 2));
                    activeSearches -= 1;
                    return [
                        song(`${query.split(" ")[0]}-seed`, "Style Artist"),
                    ];
                },
                getRadio: async (videoId) =>
                    radio(videoId.split("-")[0], videoId.split("-")[0]),
            }),
        );

        const result = await service.getMixes("user-1");

        expect(result.mixes).toHaveLength(6);
        expect(peakSearches).toBeLessThanOrEqual(3);
    });

    it("adds distinct familiar-artist directions when selected tastes are few", async () => {
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    {
                        key: "genre:rock",
                        label: "Рок",
                        query: "rock music",
                        kind: "genre",
                    },
                    {
                        key: "genre:jazz",
                        label: "Джаз",
                        query: "jazz music",
                        kind: "genre",
                    },
                ],
                loadFamiliar: async () => [
                    song("liked-muse", "Muse"),
                    song("liked-radiohead", "Radiohead"),
                    song("heard-daft", "Daft Punk"),
                ],
                searchSongs: async (_userId, query) => [
                    song(
                        `${query.split(" ")[0]}-seed`,
                        query.endsWith(" songs")
                            ? query.slice(0, -" songs".length)
                            : `${query} Artist`,
                    ),
                ],
                getRadio: async (videoId) =>
                    radio(videoId.split("-")[0], videoId.split("-")[0]),
            }),
        );

        const result = await service.getMixes("user-1");

        expect(result.mixes.map((mix) => mix.title)).toEqual([
            "Рок для вас",
            "Джаз для вас",
            "Muse и похожее",
            "Radiohead и похожее",
            "Daft Punk и похожее",
        ]);
    });

    it("does not spend two direction slots on the same selected and familiar artist", async () => {
        const searchSongs = jest.fn(async (_userId: string, query: string) => [
            song(
                `${query.split(" ")[0]}-seed`,
                query.slice(0, -" songs".length),
            ),
        ]);
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    {
                        key: "artist:Muse",
                        label: "Muse",
                        query: "Muse songs",
                        kind: "artist",
                    },
                ],
                loadFamiliar: async () => [
                    song("liked-muse", "muse"),
                    song("liked-radiohead", "Radiohead"),
                ],
                searchSongs,
                getRadio: async (videoId) =>
                    radio(videoId.split("-")[0], videoId.split("-")[0]),
            }),
        );

        const result = await service.getMixes("user-1");

        expect(result.mixes.map((mix) => mix.title)).toEqual([
            "Muse и похожее",
            "Radiohead и похожее",
        ]);
        expect(searchSongs).toHaveBeenCalledTimes(2);
    });

    it("builds separate long genre queues from different provider seeds", async () => {
        const service = new PersonalDailyMixService(dependencies());

        const result = await service.getMixes("user-1");

        expect(result.mixes.map((mix) => mix.title)).toEqual([
            "Рок для вас",
            "Джаз для вас",
        ]);
        expect(result.mixes.map((mix) => mix.tracks.length)).toEqual([40, 40]);
        expect(result.mixes[0].tracks[0].youtubeVideoId).toMatch(/^rock-/);
        expect(result.mixes[1].tracks[0].youtubeVideoId).toMatch(/^jazz-/);
        expect(
            result.mixes[0].tracks.some(
                (track) => track.youtubeVideoId === "jazz-0",
            ),
        ).toBe(false);
    });

    it("puts recently played songs after fresh candidates without shortening a mix", async () => {
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                loadRecentlyPlayed: async () => [
                    {
                        videoId: "rock-seed",
                        playedAt: new Date("2026-09-26T07:00:00Z"),
                    },
                    {
                        videoId: "rock-0",
                        playedAt: new Date("2026-09-26T06:00:00Z"),
                    },
                ],
            }),
        );

        const result = await service.getMixes("user-1");
        const ids = result.mixes[0].tracks.map((track) => track.youtubeVideoId);

        expect(ids).toHaveLength(40);
        expect(ids).not.toContain("rock-seed");
        expect(ids).not.toContain("rock-0");
    });

    it("backfills with older recent plays when there is too little fresh music", async () => {
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                getRadio: async () => radio("rock", "rock").slice(0, 24),
                loadRecentlyPlayed: async () => [
                    {
                        videoId: "rock-0",
                        playedAt: new Date("2026-09-26T07:00:00Z"),
                    },
                    {
                        videoId: "rock-1",
                        playedAt: new Date("2026-09-25T07:00:00Z"),
                    },
                ],
            }),
        );

        const result = await service.getMixes("user-1");
        const ids = result.mixes[0].tracks.map((track) => track.youtubeVideoId);

        expect(ids).toHaveLength(25);
        expect(ids.slice(-2)).toEqual(["rock-1", "rock-0"]);
    });

    it("orders fallback plays by age even when one is a liked song", async () => {
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                loadFamiliar: async () => [song("liked", "rock 1")],
                getRadio: async () => radio("rock", "rock").slice(0, 24),
                loadRecentlyPlayed: async () => [
                    {
                        videoId: "liked",
                        playedAt: new Date("2026-09-26T07:00:00Z"),
                    },
                    {
                        videoId: "rock-1",
                        playedAt: new Date("2026-09-25T07:00:00Z"),
                    },
                ],
            }),
        );

        const result = await service.getMixes("user-1");
        const ids = result.mixes[0].tracks.map((track) => track.youtubeVideoId);

        expect(ids.slice(-2)).toEqual(["rock-1", "liked"]);
    });

    it("uses familiar artists when the account has no selected tastes", async () => {
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [],
                loadFamiliar: async () => [
                    song("liked-muse", "Muse"),
                    song("heard-radiohead", "Radiohead"),
                ],
                searchSongs: async (_userId, query) =>
                    Array.from({ length: 8 }, (_, index) =>
                        song(
                            `${query.split(" ")[0]}-search-${index}`,
                            query.slice(0, -" songs".length),
                        ),
                    ),
                getRadio: async (videoId) =>
                    Array.from({ length: 5 }, (_, index) =>
                        song(`${videoId}-radio-${index}`, "Related Artist"),
                    ),
            }),
        );

        const result = await service.getMixes("user-1");

        expect(result.mixes.map((mix) => mix.title)).toEqual([
            "Muse и похожее",
            "Radiohead и похожее",
        ]);
        expect(result.mixes.every((mix) => mix.tracks.length >= 20)).toBe(true);
    });

    it("keeps a familiar song in its matching style and excludes dislikes", async () => {
        const service = new PersonalDailyMixService(
            dependencies({
                loadFamiliar: async () => [song("favorite-rock", "rock 1")],
                loadDislikedIds: async () =>
                    new Set(["rock-0", "favorite-rock"]),
            }),
        );

        const result = await service.getMixes("user-1");

        expect(
            result.mixes[0].tracks.map((track) => track.youtubeVideoId),
        ).not.toContain("rock-0");
        expect(
            result.mixes[0].tracks.map((track) => track.youtubeVideoId),
        ).not.toContain("favorite-rock");
    });

    it("hides an empty direction without copying another mix", async () => {
        const service = new PersonalDailyMixService(
            dependencies({
                getRadio: async (videoId) =>
                    videoId.startsWith("jazz") ? [] : radio("rock", "rock"),
            }),
        );

        const result = await service.getMixes("user-1");

        expect(result.mixes.map((mix) => mix.title)).toEqual(["Рок для вас"]);
    });

    it("does not show two directions backed by the same songs", async () => {
        const service = new PersonalDailyMixService(
            dependencies({
                getRadio: async () => radio("same", "Same Artist"),
            }),
        );

        const result = await service.getMixes("user-1");

        expect(result.mixes.map((mix) => mix.title)).toEqual(["Рок для вас"]);
    });

    it("mixes matching familiar tracks with new songs, without duplicates", async () => {
        const service = new PersonalDailyMixService(
            dependencies({
                loadFamiliar: async () => [
                    song("known-1", "rock 1"),
                    song("known-2", "rock 2"),
                ],
            }),
        );

        const result = await service.getMixes("user-1");
        const ids = result.mixes[0].tracks.map((track) => track.youtubeVideoId);

        expect(ids.slice(0, 3)).toContain("known-1");
        expect(ids.slice(0, 3)).toContain("rock-seed");
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toHaveLength(40);
    });

    it("anchors a genre to real catalog artists, preferring the user's familiar artist", async () => {
        const searchSongs = jest.fn(async (_userId: string, query: string) => [
            song(`${query.split(" ")[0]}-seed`, query.split(" songs")[0]),
        ]);
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    {
                        key: "genre:Рок",
                        label: "Рок",
                        query: "rock music",
                        kind: "genre",
                    },
                ],
                loadGenreArtists: async () => ["Muse", "Radiohead", "Nirvana"],
                loadFamiliar: async () => [song("familiar", "Radiohead")],
                searchSongs,
                getRadio: async () => radio("rock", "Radiohead"),
            }),
        );

        await service.getMixes("user-1");

        expect(searchSongs).toHaveBeenCalledWith("user-1", "Radiohead songs");
        expect(searchSongs).not.toHaveBeenCalledWith("user-1", "rock music");
    });

    it("keeps a long mix when the provider returns short radio queues", async () => {
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    {
                        key: "genre:Рок",
                        label: "Рок",
                        query: "rock music",
                        kind: "genre",
                    },
                ],
                loadGenreArtists: async () => ["Muse", "Radiohead"],
                searchSongs: async (_userId, query) => {
                    const artist = query.slice(0, -" songs".length);
                    return Array.from({ length: 8 }, (_, index) =>
                        song(`${artist}-search-${index}`, artist),
                    );
                },
                getRadio: async (videoId) =>
                    Array.from({ length: 5 }, (_, index) =>
                        song(`${videoId}-radio-${index}`, "Related Artist"),
                    ),
            }),
        );

        const result = await service.getMixes("user-1");

        expect(result.mixes).toHaveLength(1);
        expect(result.mixes[0].tracks.length).toBeGreaterThanOrEqual(20);
        expect(
            result.mixes[0].tracks.some(
                (track) => track.youtubeVideoId === "Muse-search-1",
            ),
        ).toBe(true);
    });

    it("coalesces repeated requests for one account without sharing another account's mix", async () => {
        const getRadio = jest.fn(async () => radio("rock", "rock"));
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                getRadio,
            }),
        );

        await Promise.all([
            service.getMixes("user-1"),
            service.getMixes("user-1"),
        ]);
        await service.getMixes("user-2");

        expect(getRadio).toHaveBeenCalledTimes(2);
    });

    it("regenerates a cached mix after the account dislikes a track", async () => {
        let dislikeState = "none";
        const getRadio = jest.fn(async () => radio("rock", "rock"));
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                loadDislikeState: async () => dislikeState,
                getRadio,
            }),
        );

        await service.getMixes("user-1");
        dislikeState = "one-dislike";
        await service.getMixes("user-1");

        expect(getRadio).toHaveBeenCalledTimes(2);
    });

    it("keeps a cached mix stable when only playback history changes and refreshes after expiry", async () => {
        let currentTime = new Date("2026-09-26T08:00:00Z");
        let recentPlays: { videoId: string; playedAt: Date }[] = [];
        const getRadio = jest.fn(async () => radio("rock", "rock"));
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                loadRecentlyPlayed: async () => recentPlays,
                getRadio,
                now: () => currentTime,
            }),
        );

        await service.getMixes("user-1");
        recentPlays = [
            {
                videoId: "rock-seed",
                playedAt: new Date("2026-09-26T08:01:00Z"),
            },
        ];
        await service.getMixes("user-1");
        expect(getRadio).toHaveBeenCalledTimes(1);

        currentTime = new Date("2026-09-26T08:11:00Z");
        const refreshed = await service.getMixes("user-1");
        expect(getRadio).toHaveBeenCalledTimes(2);
        expect(
            refreshed.mixes[0].tracks.map((track) => track.youtubeVideoId),
        ).not.toContain("rock-seed");
    });

    it("still builds mixes when playback history is unavailable", async () => {
        const service = new PersonalDailyMixService(
            dependencies({
                loadRecentlyPlayed: async () => {
                    throw new Error("history unavailable");
                },
            }),
        );

        const result = await service.getMixes("user-1");

        expect(result.mixes).toHaveLength(2);
    });
});
