jest.mock("../youtubeMusic", () => ({ ytMusicService: {} }));
jest.mock("../lastfm", () => ({ lastFmService: {} }));
jest.mock("../tasteProfile", () => ({ parseStoredTasteProfile: jest.fn() }));
jest.mock("../../utils/db", () => ({
    prisma: {
        userSettings: { findUnique: jest.fn() },
        likedRemoteTrack: { findMany: jest.fn() },
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
import { toNativeRecommendationCandidate } from "../recommendations/nativeCandidates";
import type { NativePersonalProfile } from "../recommendations/personalNativeCandidates";

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
    it("coalesces concurrent readers of an admitted native partial instead of rebuilding for each waiter", async () => {
        const now = new Date("2026-11-12T12:00:00Z");
        const native = (id: number) =>
            toNativeRecommendationCandidate(
                {
                    provider: "yandex",
                    id: String(id),
                    title: `Song ${id}`,
                    artists: [`Artist ${id}`],
                    duration: 180,
                    preview: false,
                    contentVersion: "unknown",
                },
                "fixture",
            )!;
        const seed = native(1),
            pool = Array.from({ length: 80 }, (_, index) =>
                native(index + 100),
            );
        let builds = 0,
            records = 0;
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "broken", label: "Broken", query: "broken music" },
                ],
                loadFamiliar: async () => [],
                searchSongs: async () => {
                    throw new Error("provider 503");
                },
                recordMixGeneration: async () => `generation-${++records}`,
                now: () => now,
                nativeCandidates: {
                    prepare: async () =>
                        ({
                            userId: "listener",
                            policyTime: now,
                            options: { surface: "made-for-you" },
                            recent: [],
                            liked: [],
                            plays: [],
                            knownIds: new Set(),
                            seeds: [seed],
                            degradedSources: [],
                        }) as NativePersonalProfile,
                    getBatch: async () => {
                        builds++;
                        return {
                            fresh: pool,
                            fallback: [],
                            degradedSources: [],
                        };
                    },
                    admit: async (
                        _profile: NativePersonalProfile,
                        values: typeof pool,
                    ) => ({ fresh: values, fallback: [], degradedSources: [] }),
                },
            }),
        );
        const responses = await Promise.all(
            Array.from({ length: 5 }, () => service.getMixes("listener")),
        );
        expect(builds).toBe(1);
        expect(records).toBe(1);
        expect(
            responses.map((response) => response.mixes[0].generationId),
        ).toEqual(Array(5).fill("generation-1"));
        expect(
            responses.every(
                (response) => response.mixes[0].tracks.length === 40,
            ),
        ).toBe(true);
        await service.getMixes("listener");
        expect(builds).toBe(2);
        expect(records).toBe(2);
    });
    it("renews a native mix from a static admitted pool while spacing its artists", async () => {
        let now = new Date("2026-10-14T08:00:00Z");
        const native = (id: string, artist: string) =>
            toNativeRecommendationCandidate(
                {
                    provider: "yandex",
                    id,
                    title: `Song ${id}`,
                    artists: [artist],
                    duration: 180,
                    preview: false,
                    contentVersion: "unknown",
                },
                "test",
            )!;
        const seed = native("1", "Anchor Artist");
        const pool = Array.from({ length: 80 }, (_, index) =>
            native(
                String(index + 100),
                index < 24 ? "Anchor Artist" : `Artist ${index}`,
            ),
        );
        const nativeCandidates = {
            prepare: async () =>
                ({
                    userId: "listener",
                    policyTime: now,
                    options: { surface: "made-for-you" },
                    recent: [],
                    liked: [],
                    plays: [],
                    knownIds: new Set(),
                    seeds: [seed],
                    degradedSources: [],
                }) as NativePersonalProfile,
            getBatch: async () => ({
                fresh: pool,
                fallback: [],
                degradedSources: [],
            }),
            admit: async (
                _profile: NativePersonalProfile,
                values: typeof pool,
            ) => ({
                fresh: values,
                fallback: [],
                degradedSources: [],
            }),
        };
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [],
                loadFamiliar: async () => [],
                nativeCandidates,
                now: () => now,
            }),
        );
        const first = (await service.getMixes("listener")).mixes[0].tracks;
        expect(first).toHaveLength(40);
        expect(
            new Set(first.map((track) => track.artist.name)).size,
        ).toBeGreaterThanOrEqual(35);
        expect((await service.getMixes("listener")).mixes[0].tracks).toEqual(
            first,
        );
        expect(
            first.some(
                (track, index) =>
                    index > 0 &&
                    track.artist.name === first[index - 1].artist.name,
            ),
        ).toBe(false);
        now = new Date("2026-10-15T08:00:00Z");
        const second = (await service.getMixes("listener")).mixes[0].tracks;
        expect(second).toHaveLength(40);
        expect(new Set(second.map((track) => track.id)).size).toBe(40);
        expect(
            second.filter((track) => !first.some((old) => old.id === track.id))
                .length,
        ).toBeGreaterThanOrEqual(5);
    });

    it("renews daily membership from a static catalog while keeping same-day refreshes stable", async () => {
        let now = new Date("2026-10-09T08:00:00Z");
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                loadFamiliar: async () => [],
                now: () => now,
            }),
        );
        const first = (await service.getMixes("listener")).mixes[0].tracks;
        now = new Date("2026-10-09T08:11:00Z");
        expect((await service.getMixes("listener")).mixes[0].tracks).toEqual(
            first,
        );
        now = new Date("2026-10-10T08:00:00Z");
        const second = (await service.getMixes("listener")).mixes[0].tracks;
        const firstIds = new Set(first.map((track) => track.id));
        expect(second).toHaveLength(40);
        expect(new Set(second.map((track) => track.id)).size).toBe(40);
        expect(second.some((track) => !firstIds.has(track.id))).toBe(true);
    });

    it("rotates the actual radio seed daily without increasing provider fan-out", async () => {
        let now = new Date("2026-10-09T08:00:00Z");
        const searched = Array.from({ length: 8 }, (_, i) =>
            song(`Muse-seed-${i}`, "Muse"),
        );
        const getRadio = jest.fn(async (seed: string) =>
            radio(seed, "Related Artist"),
        );
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
                loadFamiliar: async () => [],
                searchSongs: async () => searched,
                getRadio,
                now: () => now,
            }),
        );
        await service.getMixes("listener");
        const firstSeed = getRadio.mock.calls[0][0];
        now = new Date("2026-10-10T08:00:00Z");
        await service.getMixes("listener");
        expect(getRadio).toHaveBeenCalledTimes(2);
        expect(getRadio.mock.calls[1][0]).not.toBe(firstSeed);
        expect(searched.map((track) => track.videoId)).toEqual(
            Array.from({ length: 8 }, (_, i) => `Muse-seed-${i}`),
        );
    });

    it("rotates familiar genre anchors instead of permanently choosing the first catalog artist", async () => {
        let now = new Date("2026-10-09T08:00:00Z");
        const searchSongs = jest.fn(async (_userId: string, query: string) => [
            song(query.replace(/ /g, "-"), query.slice(0, -6)),
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
                loadFamiliar: async () => [
                    song("known-muse", "Muse"),
                    song("known-radiohead", "Radiohead"),
                ],
                searchSongs,
                getRadio: async () => radio("related", "Related Artist"),
                now: () => now,
            }),
        );
        await service.getMixes("listener");
        // Familiar artist directions start in parallel before the genre catalog resolves.
        const firstAnchor = searchSongs.mock.calls.at(-1)![1];
        const firstDayCalls = searchSongs.mock.calls.length;
        now = new Date("2026-10-10T08:00:00Z");
        await service.getMixes("listener");
        const genreAnchor = searchSongs.mock.calls
            .slice(firstDayCalls)
            .at(-1)![1];
        expect(["Muse songs", "Radiohead songs"]).toContain(genreAnchor);
        expect(genreAnchor).not.toBe(firstAnchor);
    });

    it("varies daily membership by account without adding unavailable tracks to a short pool", async () => {
        const service = new PersonalDailyMixService(
            dependencies({ loadFamiliar: async () => [] }),
        );
        const first = (await service.getMixes("listener-a")).mixes[0].tracks;
        const second = (await service.getMixes("listener-b")).mixes[0].tracks;
        expect(second.map((track) => track.id).sort()).not.toEqual(
            first.map((track) => track.id).sort(),
        );
        const short = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                loadFamiliar: async () => [],
                getRadio: async () =>
                    Array.from({ length: 19 }, (_, i) =>
                        song(`short-${i}`, `Artist ${i}`),
                    ),
            }),
        );
        expect((await short.getMixes("listener")).mixes[0].tracks).toHaveLength(
            20,
        );
    });

    it("uses the available artist variety before filling the remaining slots from a dominant artist", async () => {
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                loadFamiliar: async () => [],
                getRadio: async () =>
                    Array.from({ length: 48 }, (_, i) =>
                        song(
                            `radio-${i}`,
                            i < 18 ? "Dominant Artist" : `Artist ${i}`,
                        ),
                    ),
            }),
        );
        const tracks = (await service.getMixes("listener")).mixes[0].tracks;
        expect(tracks).toHaveLength(40);
        // 31 other playable songs exist: use them before the necessary nine repeats.
        expect(
            tracks.filter((track) => track.artist.name === "Dominant Artist"),
        ).toHaveLength(9);
        expect(new Set(tracks.map((track) => track.artist.name)).size).toBe(32);
        expect(
            tracks.some(
                (track, i) =>
                    i > 0 && track.artist.name === tracks[i - 1].artist.name,
            ),
        ).toBe(false);
    });

    it("rotates membership when more than forty artists have one eligible song each", async () => {
        let now = new Date("2026-10-09T08:00:00Z");
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                loadFamiliar: async () => [],
                getRadio: async () =>
                    Array.from({ length: 48 }, (_, i) =>
                        song(`unique-${i}`, `Unique Artist ${i}`),
                    ),
                now: () => now,
            }),
        );
        const ids = async (account: string) =>
            (await service.getMixes(account)).mixes[0].tracks
                .map((track) => track.id)
                .sort();
        const first = await ids("listener-a");
        expect(await ids("listener-b")).not.toEqual(first);
        now = new Date("2026-10-10T08:00:00Z");
        const nextDay = await ids("listener-a");
        expect(nextDay).toHaveLength(40);
        expect(nextDay).not.toEqual(first);
    });

    it("spaces the selected older fallback without replacing the oldest eligible recordings", async () => {
        const songs = Array.from({ length: 48 }, (_, i) =>
            song(`older-${i}`, i < 18 ? "Dominant Artist" : `Artist ${i}`),
        );
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Рок", query: "rock music" },
                ],
                loadFamiliar: async () => [],
                getRadio: async () => songs,
                loadRecentlyPlayed: async () =>
                    songs.map((track, i) => ({
                        videoId: track.videoId,
                        playedAt: new Date(
                            Date.parse("2026-09-25T08:00:00Z") + i * 60_000,
                        ),
                    })),
            }),
        );
        const tracks = (await service.getMixes("listener")).mixes[0].tracks;
        expect(tracks).toHaveLength(40);
        expect(tracks[0].youtubeVideoId).toBe("rock-seed");
        expect(
            tracks
                .slice(1)
                .map((track) => track.youtubeVideoId)
                .sort(),
        ).toEqual(
            songs
                .slice(0, 39)
                .map((track) => track.videoId)
                .sort(),
        );
        expect(
            tracks.some(
                (track, i) =>
                    i > 0 && track.artist.name === tracks[i - 1].artist.name,
            ),
        ).toBe(false);
    });

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
                    ["first", "second"].flatMap((seed) =>
                        Array.from({ length: 21 }, (_, i) => ({
                            videoId: `${seed}-${i}`,
                            playedAt: new Date("2026-09-25T08:00:00Z"),
                        })),
                    ),
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
            result.mixes[0].tracks.some(
                (t) =>
                    typeof t.youtubeVideoId === "string" &&
                    /^(?:first|second)-(?:[0-9]|1[0-9]|20)$/.test(
                        t.youtubeVideoId,
                    ),
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

    it.each([
        [" Ibrahim Maalouf ", "IBRAHIM MAALOUF"],
        ["Ibrahim\t Maalouf", "Ibrahim Maalouf"],
        ["Ｉｂｒａｈｉｍ Ｍａａｌｏｕｆ", "Ibrahim Maalouf"],
    ])("combines two distinct current dislikes for equivalent artist credits %p / %p", async (firstArtist, secondArtist) => {
        jest.mocked(prisma.dislikedEntity.findMany).mockResolvedValueOnce([
            { entityId: "yt:first" },
            { entityId: "yt:second" },
            { entityId: "yt:single" },
            { entityId: "yt:duplicate" },
        ] as never);
        jest.mocked(prisma.trackYtMusic.findMany).mockResolvedValueOnce([
            { videoId: "first", artist: firstArtist },
            { videoId: "second", artist: secondArtist },
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

    it.each([
        "Ibrahim Maalouf",
        "Ibrahim\t Maalouf",
        "Ｉｂｒａｈｉｍ Ｍａａｌｏｕｆ",
    ])("excludes equivalent suppressed credit %p from daily radio and familiar songs", async (artist) => {
        const service = new PersonalDailyMixService(
            Object.assign(
                dependencies({
                    loadDirections: async () => [
                        { key: "jazz", label: "Джаз", query: "jazz music" },
                    ],
                    loadFamiliar: async () => [
                        song("known-blocked", artist),
                    ],
                    getRadio: async () => [
                        ...radio("blocked", "Ibrahim Maalouf").map((track) => ({
                            ...track,
                            artist,
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
                    track.artist.name === artist,
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

    it("places meaningful recent listening before older likes in familiar directions", async () => {
        jest.mocked(prisma.likedRemoteTrack.findMany).mockResolvedValueOnce([
            { trackYtMusic: song("older-like", "Older Artist") },
        ] as never);
        jest.mocked(prisma.play.findMany).mockResolvedValueOnce([
            { trackYtMusic: song("recent-play", "Current Artist") },
        ] as never);
        const liveDependencies = (
            personalDailyMixService as unknown as {
                dependencies: PersonalDailyMixDependencies;
            }
        ).dependencies;
        expect(
            (await liveDependencies.loadFamiliar("listener")).map(
                (track) => track.videoId,
            ),
        ).toEqual(["recent-play", "older-like"]);
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

        const titles = result.mixes.map((mix) => mix.title);
        expect(titles).toHaveLength(6);
        expect(titles[0]).toBe("Рок для вас");
        expect(new Set(titles).size).toBe(6);
        expect(
            titles.every((title) =>
                labels.some((label) => title === `${label} для вас`),
            ),
        ).toBe(true);
        expect(result.mixes.every((mix) => mix.tracks.length >= 20)).toBe(true);
    });

    it("rotates oversubscribed selected directions across UTC days", async () => {
        let now = new Date("2026-10-14T08:00:00Z");
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
                now: () => now,
            }),
        );
        const first = (await service.getMixes("listener")).mixes.map(
            (mix) => mix.title,
        );
        const sameDay = (await service.getMixes("listener")).mixes.map(
            (mix) => mix.title,
        );
        expect(sameDay).toEqual(first);
        now = new Date("2026-10-15T08:00:00Z");
        const second = (await service.getMixes("listener")).mixes.map(
            (mix) => mix.title,
        );
        expect(first).toHaveLength(6);
        expect(second).toHaveLength(6);
        expect(first[0]).toBe("Рок для вас");
        expect(second[0]).toBe("Рок для вас");
        expect(new Set(first).size).toBe(6);
        expect(new Set(second).size).toBe(6);
        expect(second).not.toEqual(first);
        expect(new Set([...first, ...second]).size).toBe(7);
    });

    it("gives recent familiar artists a slot over stale selected directions", async () => {
        let familiar = [song("recent-one", "Current Artist")];
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () =>
                    Array.from({ length: 6 }, (_, index) => ({
                        key: `genre:${index}`,
                        label: `Style ${index}`,
                        query: `style${index} music`,
                        kind: "genre" as const,
                    })),
                loadFamiliar: async () => familiar,
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
        const first = (await service.getMixes("listener")).mixes.map(
            (mix) => mix.title,
        );
        expect(first).toContain("Current Artist и похожее");
        familiar = [song("recent-two", "New Current Artist")];
        const second = (await service.getMixes("listener")).mixes.map(
            (mix) => mix.title,
        );
        expect(second).toContain("New Current Artist и похожее");
        expect(second).not.toContain("Current Artist и похожее");
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
        expect(ids.slice(0, 3)).toContain("known-2");
        expect(
            ids.slice(0, 3).filter((id) => !id?.startsWith("known-")),
        ).toHaveLength(1);
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

    it("does not freeze an empty daily mix for ten minutes after a temporary provider failure", async () => {
        let available = false;
        const getRadio = jest.fn(async () => {
            if (!available) throw new Error("provider 503");
            return radio("recovered", "Artist");
        });
        const service = new PersonalDailyMixService(
            dependencies({
                loadDirections: async () => [
                    { key: "rock", label: "Rock", query: "rock music" },
                ],
                loadFamiliar: async () => [],
                getRadio,
            }),
        );
        expect((await service.getMixes("listener")).mixes).toHaveLength(0);
        available = true;
        const recovered = await service.getMixes("listener");
        expect(recovered.mixes).toHaveLength(1);
        expect(recovered.mixes[0].tracks).toHaveLength(40);
        expect(getRadio).toHaveBeenCalledTimes(2);
    });

    it("keeps a working daily direction visible and retries the temporarily missing one", async () => {
        let available = false;
        const service = new PersonalDailyMixService(
            dependencies({
                loadFamiliar: async () => [],
                getRadio: async (seed) => {
                    if (seed.startsWith("jazz") && !available)
                        throw new Error("provider 503");
                    return radio(seed.split("-")[0], "Artist");
                },
            }),
        );
        const first = await service.getMixes("listener");
        expect(first.mixes).toHaveLength(1);
        expect(first.mixes[0].key).toBe("rock");
        expect(first.mixes[0].tracks).toHaveLength(40);
        available = true;
        const recovered = await service.getMixes("listener");
        expect(recovered.mixes).toHaveLength(2);
        expect(recovered.mixes.map((mix) => mix.key)).toEqual(["rock", "jazz"]);
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
