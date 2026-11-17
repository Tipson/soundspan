jest.mock("../youtubeMusic", () => ({ ytMusicService: {} }));
jest.mock("../lastfm", () => ({ lastFmService: {} }));
jest.mock("../../utils/db", () => ({ prisma: {} }));
jest.mock("../../utils/logger", () => {
    const logger = { warn: jest.fn(), child: jest.fn() };
    logger.child.mockReturnValue(logger);
    return { logger };
});

import {
    PersonalDailyMixService,
    type DailyMixSong,
    type PersonalDailyMixDependencies,
    type PersonalDailyMixResult,
} from "../personalDailyMixes";

const DAY = 86_400_000;
const START = Date.parse("2026-11-17T08:00:00Z");
const profiles = [
    { name: "empty", directions: 0, familiarPerDirection: 0 },
    { name: "onboarded", directions: 1, familiarPerDirection: 0 },
    { name: "narrow", directions: 1, familiarPerDirection: 40 },
    { name: "wide", directions: 8, familiarPerDirection: 2 },
] as const;

function pool(direction: number, size: number): DailyMixSong[] {
    return Array.from({ length: size }, (_, index) => ({
        videoId: `style${direction}-${index}`,
        title: `Recording ${direction} ${index}`,
        artist:
            index < 40
                ? `Headliner ${direction}`
                : `Related ${direction} ${index % 8}`,
        album: `Album ${direction} ${Math.floor(index / 8)}`,
        duration: 180,
        thumbnailUrl: null,
    }));
}

function ids(result: PersonalDailyMixResult): Set<string> {
    return new Set(result.mixes.flatMap((mix) => mix.tracks.map((t) => t.id)));
}

describe("daily mixes frozen profile / availability / listening matrix", () => {
    for (const profile of profiles) {
        for (const size of [0, 24, 80]) {
            for (const historyAgeHours of [0, 20, 60]) {
                it(`${profile.name}: pool=${size}, history=${historyAgeHours}h`, async () => {
                    let clock = START;
                    const pools = Array.from(
                        { length: profile.directions },
                        (_, i) => pool(i, size),
                    );
                    const familiar = pools.flatMap((songs) =>
                        songs.slice(0, profile.familiarPerDirection),
                    );
                    const familiarIds = new Set(
                        familiar.map((song) => `yt:${song.videoId}`),
                    );
                    const playedAt = START - historyAgeHours * 3_600_000;
                    const heard = historyAgeHours
                        ? pools
                              .flatMap((songs) => songs.slice(0, 40))
                              .map((song) => ({
                                  videoId: song.videoId,
                                  playedAt: new Date(playedAt),
                              }))
                        : [];
                    let generations = 0;
                    const search = jest.fn(
                        async (_owner: string, query: string) => {
                            if (!size)
                                throw new Error("fixture provider unavailable");
                            const direction = Number(query.match(/\d+/)![0]);
                            return pools[direction].slice(0, 1);
                        },
                    );
                    const radio = jest.fn(async (seed: string) => {
                        const direction = Number(seed.match(/\d+/)![0]);
                        return pools[direction];
                    });
                    const dependencies: PersonalDailyMixDependencies = {
                        loadDirections: async () =>
                            pools.map((_songs, i) => ({
                                key: `artist:${i}`,
                                label: `Headliner ${i}`,
                                query: `Headliner ${i} songs`,
                                kind: "artist",
                            })),
                        loadFamiliar: async () => familiar,
                        loadRecentlyPlayed: async () =>
                            heard.filter(
                                (play) =>
                                    play.playedAt.getTime() >= clock - 7 * DAY,
                            ),
                        loadGenreArtists: async () => [],
                        searchSongs: search,
                        getRadio: radio,
                        loadDislikedIds: async () => new Set(),
                        loadDislikeState: async () => "none",
                        loadSuppressedArtistKeys: async () => new Set(),
                        recordMixGeneration: async ({ userId, mix }) =>
                            `${userId}:${mix.key}:${++generations}`,
                        now: () => new Date(clock),
                    };
                    const service = new PersonalDailyMixService(dependencies);
                    const owner = `matrix-${profile.name}`;
                    const first = await service.getMixes(owner);
                    clock += 60_000;
                    const cached = await service.getMixes(owner);
                    if (size || profile.name === "empty")
                        expect(cached).toEqual(first);
                    else expect(ids(cached)).toEqual(ids(first));
                    clock = START + 11 * 60_000;
                    const refreshed = await service.getMixes(owner);
                    expect(ids(refreshed)).toEqual(ids(first));
                    const measurements = [];
                    for (const day of [0, 1, 3]) {
                        clock = START + day * DAY;
                        const result =
                            day === 0 ? first : await service.getMixes(owner);
                        const served = ids(result);
                        expect(result.mixes).toHaveLength(
                            profile.directions && size
                                ? Math.min(6, profile.directions)
                                : 0,
                        );
                        const all = result.mixes.flatMap((mix) => mix.tracks);
                        expect(served.size).toBe(all.length);
                        for (const mix of result.mixes) {
                            expect(mix.tracks).toHaveLength(Math.min(40, size));
                            expect(mix.snapshot).toMatchObject({
                                requestedCount: 40,
                                availableCount: mix.tracks.length,
                                compositionDay: new Date(clock)
                                    .toISOString()
                                    .slice(0, 10),
                                reasons: size < 40 ? ["pool_limited"] : [],
                            });
                            expect(
                                mix.tracks.filter((track) =>
                                    familiarIds.has(track.id),
                                ).length,
                            ).toBeLessThanOrEqual(27);
                        }
                        if (profile.directions && !size) {
                            expect(result.statuses).toHaveLength(
                                Math.min(6, profile.directions),
                            );
                            expect(
                                result.statuses?.every((status) =>
                                    status.snapshot.reasons.includes(
                                        "provider_degraded",
                                    ),
                                ),
                            ).toBe(true);
                        }
                        const repeated = heard.filter((play) =>
                            served.has(`yt:${play.videoId}`),
                        );
                        if (size === 80) expect(repeated).toHaveLength(0);
                        measurements.push({
                            day,
                            mixCount: result.mixes.length,
                            available: all.length,
                            familiar: all.filter((track) =>
                                familiarIds.has(track.id),
                            ).length,
                            overlapDay0: [...served].filter((id) =>
                                ids(first).has(id),
                            ).length,
                            repeats24h: repeated.filter(
                                (play) =>
                                    clock - play.playedAt.getTime() <= DAY,
                            ).length,
                            repeats72h: repeated.filter(
                                (play) =>
                                    clock - play.playedAt.getTime() <= 3 * DAY,
                            ).length,
                            directionKeys: result.mixes.map((mix) => mix.key),
                        });
                    }
                    if (profile.name === "empty") {
                        expect(search).not.toHaveBeenCalled();
                        expect(radio).not.toHaveBeenCalled();
                    }
                    const observe = Reflect.get(
                        globalThis,
                        "__DEV12_PROFILE_MATRIX__",
                    );
                    if (typeof observe === "function")
                        observe({
                            profile: profile.name,
                            size,
                            historyAgeHours,
                            measurements,
                        });
                });
            }
        }
    }
});
