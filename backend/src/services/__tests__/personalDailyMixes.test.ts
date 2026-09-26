jest.mock("../youtubeMusic", () => ({ ytMusicService: {} }));
jest.mock("../lastfm", () => ({ lastFmService: {} }));
jest.mock("../tasteProfile", () => ({ parseStoredTasteProfile: jest.fn() }));
jest.mock("../../utils/db", () => ({ prisma: {} }));
jest.mock("../../utils/logger", () => {
    const logger = { warn: jest.fn(), child: jest.fn() };
    logger.child.mockReturnValue(logger);
    return { logger };
});

import {
    PersonalDailyMixService,
    type PersonalDailyMixDependencies,
} from "../personalDailyMixes";

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
        loadGenreArtists: async () => [],
        searchSongs: async (_userId, query) => [
            song(`${query.split(" ")[0]}-seed`, `${query} Artist`),
        ],
        getRadio: async (videoId) =>
            radio(videoId.split("-")[0], videoId.split("-")[0]),
        loadDislikedIds: async () => new Set<string>(),
        loadDislikeState: async () => "none",
        now: () => new Date("2026-09-26T08:00:00Z"),
        ...overrides,
    };
}

describe("PersonalDailyMixService", () => {
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
});
