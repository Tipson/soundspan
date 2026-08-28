const mockDefaultGetRadio = jest.fn();
const mockPrisma = {
    play: { findMany: jest.fn() },
    likedRemoteTrack: { findMany: jest.fn() },
    playlistItem: { findMany: jest.fn() },
    dislikedEntity: { findMany: jest.fn() },
};

jest.mock("../youtubeMusic", () => ({
    ytMusicService: { getRadio: mockDefaultGetRadio },
}));

jest.mock("../../utils/db", () => ({ prisma: mockPrisma }));

import {
    PersonalizedCatalogService,
    personalizedCatalogService,
    type PersonalizedCatalogDependencies,
    type PersonalizedCatalogSignals,
} from "../personalizedCatalog";

type StoredYoutubeTrack = PersonalizedCatalogSignals["recentPlays"][number];

function storedTrack(
    videoId: string,
    overrides: Partial<StoredYoutubeTrack> = {},
): StoredYoutubeTrack {
    return {
        id: `row-${videoId}`,
        videoId,
        title: `Title ${videoId}`,
        artist: `Artist ${videoId}`,
        album: `Album ${videoId}`,
        duration: 180,
        thumbnailUrl: `https://img.example/${videoId}.jpg`,
        artistId: null,
        albumId: null,
        ...overrides,
    };
}

function radioTrack(videoId: string, overrides: Record<string, unknown> = {}) {
    return {
        videoId,
        title: `Radio ${videoId}`,
        artist: `Radio Artist ${videoId}`,
        artists: [`Radio Artist ${videoId}`],
        album: `Radio Album ${videoId}`,
        duration: 200,
        thumbnailUrl: `https://img.example/${videoId}.jpg`,
        ...overrides,
    };
}

const emptySignals = (): PersonalizedCatalogSignals => ({
    recentPlays: [],
    likedTracks: [],
    playlistTracks: [],
    dislikedEntityIds: [],
});

function createService(
    dependencies: Pick<
        PersonalizedCatalogDependencies,
        "loadSignals" | "getRadio"
    > &
        Partial<Pick<PersonalizedCatalogDependencies, "loadDislikedEntityIds">>,
): PersonalizedCatalogService {
    return new PersonalizedCatalogService({
        loadDislikedEntityIds: async () => [],
        ...dependencies,
    });
}

describe("PersonalizedCatalogService", () => {
    it("builds a playable remote-only home feed from plays, likes, playlists, and provider radio", async () => {
        const loadSignals = jest.fn(async () => ({
            recentPlays: [storedTrack("played")],
            likedTracks: [storedTrack("liked")],
            playlistTracks: [storedTrack("playlist")],
            dislikedEntityIds: [],
        }));
        const getRadio = jest.fn(async (seedVideoId: string) => ({
            playlistId: `RDAMVM${seedVideoId}`,
            seedVideoId,
            tracks: [radioTrack("radio-1")],
        }));
        const service = createService({
            loadSignals,
            getRadio,
        });

        const result = await service.getHomeFeed("user-1", 12);

        expect(loadSignals).toHaveBeenCalledWith("user-1");
        expect(result.shelves.listenAgain.map((track) => track.id)).toEqual([
            "yt:played",
        ]);
        expect(result.shelves.quickPicks.map((track) => track.id)).toEqual([
            "yt:liked",
            "yt:playlist",
        ]);
        expect(result.shelves.discovery.map((track) => track.id)).toEqual([
            "yt:radio-1",
        ]);
        expect(result.seedCount).toBe(3);
        expect(result).toEqual(
            expect.objectContaining({ degraded: false, reason: null }),
        );

        for (const track of Object.values(result.shelves).flat()) {
            expect(track).toEqual(
                expect.objectContaining({
                    id: expect.stringMatching(/^yt:/),
                    source: "youtube",
                    streamSource: "youtube",
                    youtubeVideoId: expect.any(String),
                    title: expect.any(String),
                    duration: expect.any(Number),
                    artist: expect.objectContaining({
                        name: expect.any(String),
                    }),
                    album: expect.objectContaining({
                        title: expect.any(String),
                        coverArt: expect.any(String),
                    }),
                    provider: {
                        tidalTrackId: null,
                        youtubeVideoId: expect.any(String),
                    },
                }),
            );
        }
    });

    it("deduplicates shelves and excludes disliked, recent, and seed tracks from discovery", async () => {
        const loadSignals = jest.fn(async () => ({
            recentPlays: [storedTrack("recent"), storedTrack("recent")],
            likedTracks: [storedTrack("seed"), storedTrack("recent")],
            playlistTracks: [
                storedTrack("seed"),
                storedTrack("playlist-only"),
                storedTrack("disliked"),
            ],
            dislikedEntityIds: ["yt:disliked"],
        }));
        const getRadio = jest.fn(async (seedVideoId: string) => ({
            playlistId: null,
            seedVideoId,
            tracks: [
                radioTrack(seedVideoId),
                radioTrack("recent"),
                radioTrack("disliked"),
                radioTrack("playlist-only"),
                radioTrack("new-1"),
                radioTrack("new-1"),
                radioTrack("new-2"),
            ],
        }));
        const service = createService({
            loadSignals,
            getRadio,
        });

        const result = await service.getHomeFeed("user-1", 12);

        expect(result.shelves.listenAgain.map((track) => track.id)).toEqual([
            "yt:recent",
        ]);
        expect(result.shelves.quickPicks.map((track) => track.id)).toEqual([
            "yt:seed",
            "yt:playlist-only",
        ]);
        expect(result.shelves.discovery.map((track) => track.id)).toEqual([
            "yt:new-1",
            "yt:new-2",
        ]);
        const allIds = Object.values(result.shelves)
            .flat()
            .map((track) => track.id);
        expect(new Set(allIds).size).toBe(allIds.length);
        expect(allIds).not.toContain("yt:disliked");
    });

    it("keeps fulfilled radio results and reports a partial provider failure", async () => {
        const loadSignals = jest.fn(async () => ({
            ...emptySignals(),
            likedTracks: [storedTrack("seed-a"), storedTrack("seed-b")],
        }));
        const getRadio = jest.fn(async (seedVideoId: string) => {
            if (seedVideoId === "seed-a") {
                throw new Error("provider timeout");
            }
            return {
                playlistId: null,
                seedVideoId,
                tracks: [radioTrack("survivor")],
            };
        });
        const service = createService({
            loadSignals,
            getRadio,
        });

        const result = await service.getHomeFeed("user-1", 12);

        expect(result.shelves.discovery.map((track) => track.id)).toEqual([
            "yt:survivor",
        ]);
        expect(result.degraded).toBe(true);
        expect(result.reason).toBe("provider_partial_failure");
        expect(result.seedCount).toBe(2);
    });

    it("returns existing shelves and reports provider unavailable when every radio call fails", async () => {
        const loadSignals = jest.fn(async () => ({
            ...emptySignals(),
            recentPlays: [storedTrack("recent")],
        }));
        const getRadio = jest.fn(async () => {
            throw new Error("provider offline");
        });
        const service = createService({
            loadSignals,
            getRadio,
        });

        const result = await service.getHomeFeed("user-1", 12);

        expect(result.shelves.listenAgain).toHaveLength(1);
        expect(result.shelves.discovery).toEqual([]);
        expect(result.degraded).toBe(true);
        expect(result.reason).toBe("provider_unavailable");
        expect(result.seedCount).toBe(1);
    });

    it("reports provider unavailable when every radio queue is genuinely empty", async () => {
        const loadSignals = jest.fn(async () => ({
            ...emptySignals(),
            likedTracks: [storedTrack("seed")],
        }));
        const getRadio = jest.fn(async (seedVideoId: string) => ({
            playlistId: null,
            seedVideoId,
            tracks: [],
        }));
        const service = createService({ loadSignals, getRadio });

        const result = await service.getHomeFeed("user-1", 12);

        expect(result.shelves.discovery).toEqual([]);
        expect(result.degraded).toBe(true);
        expect(result.reason).toBe("provider_unavailable");
        expect(result.seedCount).toBe(1);
    });

    it("returns insufficient_signals without calling the provider when the user has no remote signals", async () => {
        const loadSignals = jest.fn(async () => emptySignals());
        const getRadio = jest.fn();
        const service = createService({
            loadSignals,
            getRadio,
        });

        const result = await service.getHomeFeed("user-1", 12);

        expect(getRadio).not.toHaveBeenCalled();
        expect(result).toEqual({
            shelves: { listenAgain: [], quickPicks: [], discovery: [] },
            degraded: false,
            reason: "insufficient_signals",
            seedCount: 0,
        });
    });

    it("does not seed recommendations from a persisted canonical remote dislike", async () => {
        const loadSignals = jest.fn(async () => ({
            ...emptySignals(),
            likedTracks: [storedTrack("excluded-seed")],
        }));
        const getRadio = jest.fn();
        const loadDislikedEntityIds = jest.fn(async () => ["yt:excluded-seed"]);
        const service = createService({
            loadSignals,
            getRadio,
            loadDislikedEntityIds,
        });

        const result = await service.getHomeFeed("user-1", 12);

        expect(result.shelves.quickPicks).toEqual([]);
        expect(result.shelves.discovery).toEqual([]);
        expect(result.reason).toBe("insufficient_signals");
        expect(getRadio).not.toHaveBeenCalled();
        expect(loadDislikedEntityIds).toHaveBeenCalledWith("user-1", [
            "yt:excluded-seed",
        ]);
    });

    it("checks exact provider candidates so an older persisted dislike cannot reappear", async () => {
        const loadSignals = jest.fn(async () => ({
            ...emptySignals(),
            likedTracks: [storedTrack("seed")],
        }));
        const getRadio = jest.fn(async (seedVideoId: string) => ({
            playlistId: null,
            seedVideoId,
            tracks: [radioTrack("older-dislike"), radioTrack("allowed")],
        }));
        const loadDislikedEntityIds = jest.fn(
            async (_userId: string, canonicalIds: string[]) =>
                canonicalIds.includes("yt:older-dislike")
                    ? ["yt:older-dislike"]
                    : [],
        );
        const service = createService({
            loadSignals,
            getRadio,
            loadDislikedEntityIds,
        });

        const result = await service.getHomeFeed("user-1", 12);

        expect(result.shelves.discovery.map((track) => track.id)).toEqual([
            "yt:allowed",
        ]);
        expect(loadDislikedEntityIds).toHaveBeenCalledWith(
            "user-1",
            expect.arrayContaining(["yt:older-dislike", "yt:allowed"]),
        );
    });

    it("keeps concurrent user feeds isolated and forwards each user id to the signal source", async () => {
        const loadSignals = jest.fn(async (userId: string) => ({
            ...emptySignals(),
            likedTracks: [storedTrack(`${userId}-seed`)],
        }));
        const getRadio = jest.fn(async (seedVideoId: string) => ({
            playlistId: null,
            seedVideoId,
            tracks: [radioTrack(`${seedVideoId}-discovery`)],
        }));
        const service = createService({
            loadSignals,
            getRadio,
        });

        const [first, second] = await Promise.all([
            service.getHomeFeed("alice", 12),
            service.getHomeFeed("bob", 12),
        ]);

        expect(loadSignals).toHaveBeenCalledWith("alice");
        expect(loadSignals).toHaveBeenCalledWith("bob");
        expect(first.shelves.quickPicks[0].id).toBe("yt:alice-seed");
        expect(first.shelves.discovery[0].id).toBe("yt:alice-seed-discovery");
        expect(second.shelves.quickPicks[0].id).toBe("yt:bob-seed");
        expect(second.shelves.discovery[0].id).toBe("yt:bob-seed-discovery");
    });

    it("scopes every persisted signal query to the requested user", async () => {
        mockPrisma.play.findMany.mockResolvedValueOnce([]);
        mockPrisma.likedRemoteTrack.findMany.mockResolvedValueOnce([
            { trackYtMusic: storedTrack("isolated-signal") },
        ]);
        mockPrisma.playlistItem.findMany.mockResolvedValueOnce([]);
        mockPrisma.dislikedEntity.findMany.mockResolvedValue([]);
        mockDefaultGetRadio.mockResolvedValue({
            playlistId: null,
            seedVideoId: "isolated-signal",
            tracks: [],
        });

        await personalizedCatalogService.getHomeFeed("isolated-user", 12);

        expect(mockPrisma.play.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ userId: "isolated-user" }),
            }),
        );
        expect(mockPrisma.likedRemoteTrack.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ userId: "isolated-user" }),
            }),
        );
        expect(mockPrisma.playlistItem.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    playlist: { is: { userId: "isolated-user" } },
                }),
            }),
        );
        expect(mockPrisma.dislikedEntity.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    userId: "isolated-user",
                    entityType: "track",
                    entityId: { in: ["yt:isolated-signal"] },
                }),
            }),
        );
        expect(mockDefaultGetRadio).toHaveBeenCalledWith("isolated-signal", 36);
    });

    it("uses safe metadata defaults while preserving a canonical playable YouTube identity", async () => {
        const loadSignals = jest.fn(async () => ({
            ...emptySignals(),
            likedTracks: [storedTrack("seed")],
        }));
        const getRadio = jest.fn(async (seedVideoId: string) => ({
            playlistId: null,
            seedVideoId,
            tracks: [
                radioTrack("sparse", {
                    title: " ",
                    artist: " ",
                    artists: [],
                    album: " ",
                    duration: Number.NaN,
                    thumbnailUrl: null,
                }),
            ],
        }));
        const service = createService({
            loadSignals,
            getRadio,
        });

        const result = await service.getHomeFeed("user-1", 12);

        expect(result.shelves.discovery[0]).toEqual(
            expect.objectContaining({
                id: "yt:sparse",
                title: "Unknown Track",
                duration: 0,
                streamSource: "youtube",
                youtubeVideoId: "sparse",
                artist: { id: null, name: "Unknown Artist" },
                album: expect.objectContaining({
                    title: "Single",
                    coverArt: "https://i.ytimg.com/vi/sparse/hqdefault.jpg",
                }),
                provider: { tidalTrackId: null, youtubeVideoId: "sparse" },
            }),
        );
    });

    it("skips malformed provider rows without discarding valid radio tracks", async () => {
        const loadSignals = jest.fn(async () => ({
            ...emptySignals(),
            likedTracks: [storedTrack("seed")],
        }));
        const getRadio = jest.fn(async (seedVideoId: string) => ({
            playlistId: null,
            seedVideoId,
            tracks: [
                null as unknown as ReturnType<typeof radioTrack>,
                radioTrack("valid"),
            ],
        }));
        const service = createService({
            loadSignals,
            getRadio,
        });

        const result = await service.getHomeFeed("user-1", 12);

        expect(result.shelves.discovery.map((track) => track.id)).toEqual([
            "yt:valid",
        ]);
    });

    it("enforces the requested provider result bound even if the provider returns extra rows", async () => {
        const loadSignals = jest.fn(async () => ({
            ...emptySignals(),
            likedTracks: [storedTrack("seed")],
        }));
        const getRadio = jest.fn(async (seedVideoId: string) => ({
            playlistId: null,
            seedVideoId,
            tracks: [
                ...Array.from(
                    { length: 12 },
                    () => null as unknown as ReturnType<typeof radioTrack>,
                ),
                radioTrack("outside-requested-bound"),
            ],
        }));
        const service = createService({
            loadSignals,
            getRadio,
        });

        const result = await service.getHomeFeed("user-1", 1);

        expect(getRadio).toHaveBeenCalledWith("seed", 12);
        expect(result.shelves.discovery).toEqual([]);
    });

    it("launches at most three distinct radio seeds", async () => {
        const loadSignals = jest.fn(async () => ({
            ...emptySignals(),
            likedTracks: Array.from({ length: 8 }, (_, index) =>
                storedTrack(`seed-${index}`),
            ),
        }));
        const getRadio = jest.fn(async (seedVideoId: string) => ({
            playlistId: null,
            seedVideoId,
            tracks: [],
        }));
        const service = createService({
            loadSignals,
            getRadio,
        });

        const result = await service.getHomeFeed("user-1", 12);

        expect(getRadio).toHaveBeenCalledTimes(3);
        expect(result.seedCount).toBe(3);
    });

    it("selects one eligible seed per signal source before filling remaining slots", async () => {
        const loadSignals = jest.fn(async () => ({
            ...emptySignals(),
            recentPlays: [storedTrack("recent")],
            likedTracks: [
                storedTrack("recent"),
                storedTrack("disliked"),
                ...Array.from({ length: 61 }, (_, index) =>
                    storedTrack(`liked-${index}`),
                ),
            ],
            playlistTracks: [storedTrack("playlist")],
            dislikedEntityIds: ["yt:disliked"],
        }));
        const getRadio = jest.fn(async (seedVideoId: string) => ({
            playlistId: null,
            seedVideoId,
            tracks: [],
        }));
        const service = createService({ loadSignals, getRadio });

        await service.getHomeFeed("user-1", 12);

        expect(getRadio.mock.calls.map(([seedVideoId]) => seedVideoId)).toEqual(
            ["recent", "liked-0", "playlist"],
        );
    });
});
