jest.mock("../youtubeMusic", () => ({
    ytMusicService: { searchCanonical: jest.fn() },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        userSettings: { findUnique: jest.fn(), upsert: jest.fn() },
        play: { findFirst: jest.fn() },
        likedRemoteTrack: { findFirst: jest.fn() },
        playlistItem: { findFirst: jest.fn() },
    },
}));

jest.mock("../../utils/logger", () => {
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);
    return { logger };
});

import {
    TasteProfileService,
    TasteProfileUnavailableError,
    tasteProfileService,
    type TasteProfileDependencies,
    type TasteProfilePersistenceState,
    type TasteProfileWrite,
} from "../tasteProfile";

const { prisma } = jest.requireMock("../../utils/db") as {
    prisma: {
        userSettings: { findUnique: jest.Mock; upsert: jest.Mock };
        play: { findFirst: jest.Mock };
        likedRemoteTrack: { findFirst: jest.Mock };
        playlistItem: { findFirst: jest.Mock };
    };
};

function emptyState(
    overrides: Partial<TasteProfilePersistenceState> = {},
): TasteProfilePersistenceState {
    return {
        tasteProfile: null,
        tasteProfileCompletedAt: null,
        tasteProfileSkippedAt: null,
        ...overrides,
    };
}

function profileSeed(videoId: string) {
    return {
        id: `taste:${videoId}`,
        videoId,
        title: `Track ${videoId}`,
        artist: `Artist ${videoId}`,
        album: "Single",
        duration: 180,
        thumbnailUrl: `https://img.example/${videoId}.jpg`,
        artistId: null,
        albumId: null,
    };
}

function createDependencies(
    overrides: Partial<TasteProfileDependencies> = {},
): TasteProfileDependencies {
    return {
        loadState: jest.fn(async () => emptyState()),
        hasMeaningfulSignals: jest.fn(async () => false),
        saveState: jest.fn(async (_userId: string, write: TasteProfileWrite) =>
            emptyState({
                tasteProfile: write.tasteProfile,
                tasteProfileCompletedAt: write.tasteProfileCompletedAt,
                tasteProfileSkippedAt: write.tasteProfileSkippedAt,
            }),
        ),
        searchSongs: jest.fn(async (_userId, query, _options) => [
            {
                providerTrackId: `video-${query.replace(/\s+/g, "-")}`,
                title: `Track ${query}`,
                artistName: `Artist ${query}`,
                albumTitle: null,
                durationSec: 180,
                thumbnailUrl: null,
            },
        ]),
        now: () => new Date("2026-08-30T12:00:00.000Z"),
        ...overrides,
    };
}

describe("TasteProfileService", () => {
    it("keeps profile reads and signal checks scoped to the authenticated account", async () => {
        const states = new Map<string, TasteProfilePersistenceState>([
            [
                "alice",
                emptyState({
                    tasteProfile: {
                        genres: ["Rock"],
                        artists: ["Linkin Park", "Muse"],
                        seedTracks: [profileSeed("alice-seed")],
                    },
                    tasteProfileCompletedAt: new Date(
                        "2026-08-29T12:00:00.000Z",
                    ),
                }),
            ],
            ["bob", emptyState()],
        ]);
        const loadState = jest.fn(
            async (userId: string) => states.get(userId) ?? emptyState(),
        );
        const hasMeaningfulSignals = jest.fn(
            async (userId: string) => userId === "bob",
        );
        const service = new TasteProfileService(
            createDependencies({ loadState, hasMeaningfulSignals }),
        );

        const [alice, bob] = await Promise.all([
            service.getProfile("alice"),
            service.getProfile("bob"),
        ]);

        expect(loadState.mock.calls).toEqual([["alice"], ["bob"]]);
        expect(hasMeaningfulSignals).toHaveBeenCalledWith("bob");
        expect(hasMeaningfulSignals).not.toHaveBeenCalledWith("alice");
        expect(alice.profile?.artists).toEqual(["Linkin Park", "Muse"]);
        expect(alice.needsOnboarding).toBe(false);
        expect(bob.profile).toBeNull();
        expect(bob.needsOnboarding).toBe(false);
    });

    it("does not treat malformed or incomplete persisted JSON as completed onboarding", async () => {
        const hasMeaningfulSignals = jest.fn(async () => false);
        const service = new TasteProfileService(
            createDependencies({
                loadState: jest.fn(async () =>
                    emptyState({
                        tasteProfile: {
                            genres: ["Rock"],
                            artists: ["Muse", "Кино"],
                            seedTracks: [],
                        },
                    }),
                ),
                hasMeaningfulSignals,
            }),
        );

        const result = await service.getProfile("alice");

        expect(result.profile).toBeNull();
        expect(result.completedAt).toBeNull();
        expect(result.needsOnboarding).toBe(true);
        expect(hasMeaningfulSignals).toHaveBeenCalledWith("alice");
    });

    it("resolves bounded playable seeds and keeps successful results when one provider query fails", async () => {
        const saveState = jest.fn(
            async (_userId: string, write: TasteProfileWrite) =>
                emptyState({
                    tasteProfile: write.tasteProfile,
                    tasteProfileCompletedAt: write.tasteProfileCompletedAt,
                    tasteProfileSkippedAt: write.tasteProfileSkippedAt,
                }),
        );
        const searchSongs = jest.fn(
            async (
                _userId: string,
                query: string,
                _options: { limit: number; timeoutMs: number },
            ) => {
                if (query.includes("Metal")) {
                    throw new Error("provider timeout");
                }
                return [
                    {
                        providerTrackId: `video-${query.replace(/\s+/g, "-")}`,
                        title: `Track ${query}`,
                        artistName: query,
                        albumTitle: "Album",
                        durationSec: 205,
                        thumbnailUrl: "https://img.example/cover.jpg",
                    },
                ];
            },
        );
        const service = new TasteProfileService(
            createDependencies({ saveState, searchSongs }),
        );

        const result = await service.saveProfile("alice", {
            genres: [" Rock ", "Metal", "rock"],
            artists: ["Linkin Park", "Muse"],
        });

        expect(searchSongs).toHaveBeenCalledTimes(4);
        for (const call of searchSongs.mock.calls) {
            expect(call[0]).toBe("alice");
            expect(call[2]).toEqual({ limit: 3, timeoutMs: 5_000 });
        }
        expect(saveState).toHaveBeenCalledWith(
            "alice",
            expect.objectContaining({
                tasteProfile: expect.objectContaining({
                    genres: ["Rock", "Metal"],
                    artists: ["Linkin Park", "Muse"],
                    seedTracks: expect.arrayContaining([
                        expect.objectContaining({
                            videoId: "video-Rock-music",
                        }),
                        expect.objectContaining({
                            videoId: "video-Linkin-Park-songs",
                        }),
                    ]),
                }),
                tasteProfileCompletedAt: new Date("2026-08-30T12:00:00.000Z"),
                tasteProfileSkippedAt: null,
            }),
        );
        expect(result.profile?.seedTracks).toHaveLength(3);
        expect(result.needsOnboarding).toBe(false);
    });

    it("does not mark onboarding complete when no playable seed can be resolved", async () => {
        const saveState = jest.fn();
        const service = new TasteProfileService(
            createDependencies({
                saveState,
                searchSongs: jest.fn(async () => {
                    throw new Error("provider unavailable");
                }),
            }),
        );

        await expect(
            service.saveProfile("alice", {
                genres: ["Rock", "Metal"],
                artists: ["Muse"],
            }),
        ).rejects.toBeInstanceOf(TasteProfileUnavailableError);
        expect(saveState).not.toHaveBeenCalled();
    });

    it("never runs more than three provider seed queries concurrently", async () => {
        let active = 0;
        let maxActive = 0;
        const searchSongs = jest.fn(async (_userId: string, query: string) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return [
                {
                    providerTrackId: `video-${query.replace(/\s+/g, "-")}`,
                    title: query,
                    artistName: query,
                    albumTitle: null,
                    durationSec: 180,
                    thumbnailUrl: null,
                },
            ];
        });
        const service = new TasteProfileService(
            createDependencies({ searchSongs }),
        );

        await service.saveProfile("alice", {
            genres: ["Rock", "Metal", "Pop", "Jazz", "Indie"],
            artists: ["Muse", "Кино", "Rammstein", "Queen", "ABBA"],
        });

        expect(maxActive).toBe(3);
    });

    it("bounds provider calls even when the provider never settles", async () => {
        jest.useFakeTimers();
        try {
            const service = new TasteProfileService(
                createDependencies({
                    searchSongs: jest.fn(
                        async () =>
                            new Promise<never>(() => {
                                // Intentionally never settles.
                            }),
                    ),
                }),
            );

            const result = service.saveProfile("alice", {
                genres: ["Rock", "Metal", "Pop"],
                artists: [],
            });
            const assertion = expect(result).rejects.toBeInstanceOf(
                TasteProfileUnavailableError,
            );
            await jest.advanceTimersByTimeAsync(5_001);
            await assertion;
        } finally {
            jest.useRealTimers();
        }
    });

    it("does not consume provider results beyond the requested per-query limit", async () => {
        const invalid = {
            providerTrackId: "bad id",
            title: "Invalid",
            artistName: "Invalid",
            albumTitle: null,
            durationSec: 180,
            thumbnailUrl: null,
        };
        const service = new TasteProfileService(
            createDependencies({
                searchSongs: jest.fn(async () => [
                    invalid,
                    invalid,
                    invalid,
                    {
                        ...invalid,
                        providerTrackId: "outside-bound",
                    },
                ]),
            }),
        );

        await expect(
            service.saveProfile("alice", {
                genres: ["Rock", "Metal", "Pop"],
                artists: [],
            }),
        ).rejects.toBeInstanceOf(TasteProfileUnavailableError);
    });

    it("stores skip per account and allows a later completed profile to replace it", async () => {
        const writes: Array<{ userId: string; write: TasteProfileWrite }> = [];
        const saveState = jest.fn(async (userId, write) => {
            writes.push({ userId, write });
            return emptyState({
                tasteProfile: write.tasteProfile,
                tasteProfileCompletedAt: write.tasteProfileCompletedAt,
                tasteProfileSkippedAt: write.tasteProfileSkippedAt,
            });
        });
        const service = new TasteProfileService(
            createDependencies({ saveState }),
        );

        const skipped = await service.skipProfile("bob");
        const completed = await service.saveProfile("bob", {
            genres: ["Rock"],
            artists: ["Muse", "Кино"],
        });

        expect(skipped.profile).toBeNull();
        expect(skipped.skippedAt).toBe("2026-08-30T12:00:00.000Z");
        expect(completed.profile?.artists).toEqual(["Muse", "Кино"]);
        expect(writes).toEqual([
            {
                userId: "bob",
                write: {
                    tasteProfile: null,
                    tasteProfileCompletedAt: null,
                    tasteProfileSkippedAt: new Date("2026-08-30T12:00:00.000Z"),
                },
            },
            expect.objectContaining({
                userId: "bob",
                write: expect.objectContaining({
                    tasteProfileSkippedAt: null,
                }),
            }),
        ]);
    });
});

describe("tasteProfileService Prisma account scope", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.play.findFirst.mockResolvedValue(null);
        prisma.likedRemoteTrack.findFirst.mockResolvedValue(null);
        prisma.playlistItem.findFirst.mockResolvedValue(null);
    });

    it("never reads one account's profile or signals through another account id", async () => {
        prisma.userSettings.findUnique.mockImplementation(
            async ({ where }: { where: { userId: string } }) =>
                where.userId === "alice"
                    ? emptyState({
                          tasteProfile: {
                              genres: ["Rock"],
                              artists: ["Muse", "Кино"],
                              seedTracks: [profileSeed("alice-seed")],
                          },
                          tasteProfileCompletedAt: new Date(
                              "2026-08-30T10:00:00.000Z",
                          ),
                      })
                    : null,
        );
        prisma.likedRemoteTrack.findFirst.mockImplementation(
            async ({ where }: { where: { userId: string } }) =>
                where.userId === "bob" ? { id: "bob-like" } : null,
        );

        const [alice, bob] = await Promise.all([
            tasteProfileService.getProfile("alice"),
            tasteProfileService.getProfile("bob"),
        ]);

        expect(alice.profile?.genres).toEqual(["Rock"]);
        expect(bob.profile).toBeNull();
        expect(bob.needsOnboarding).toBe(false);
        expect(prisma.userSettings.findUnique.mock.calls).toEqual(
            expect.arrayContaining([
                [expect.objectContaining({ where: { userId: "alice" } })],
                [expect.objectContaining({ where: { userId: "bob" } })],
            ]),
        );
        for (const call of prisma.play.findFirst.mock.calls) {
            expect(call[0].where.userId).toBe("bob");
            expect(call[0].where.AND).toEqual(
                expect.arrayContaining([
                    {
                        OR: [
                            { trackYtMusicId: { not: null } },
                            { trackTidalId: { not: null } },
                        ],
                    },
                ]),
            );
        }
        for (const call of prisma.likedRemoteTrack.findFirst.mock.calls) {
            expect(call[0].where.userId).toBe("bob");
        }
        for (const call of prisma.playlistItem.findFirst.mock.calls) {
            expect(call[0].where.playlist).toEqual({ is: { userId: "bob" } });
        }
    });
});
