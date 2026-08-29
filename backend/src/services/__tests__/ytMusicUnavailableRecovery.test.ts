const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

jest.mock("../../utils/logger", () => ({ logger: mockLogger }));
jest.mock("../../utils/db", () => ({ prisma: {} }));
jest.mock("../trackMappingService", () => ({
    trackMappingService: { ensureRemoteTrack: jest.fn() },
}));
jest.mock("../youtubeMusic", () => ({
    ytMusicService: {
        getStreamInfo: jest.fn(),
        findPlayableAlternateForTrack: jest.fn(),
    },
}));

import {
    createYtMusicUnavailableRecoveryService,
    persistPlaylistYtMusicReplacement,
    type YtMusicUnavailableRecoveryDependencies,
} from "../ytMusicUnavailableRecovery";

const makeUnavailable = (status: 404 | 451) => ({
    response: { status },
});

const makeDependencies =
    (): jest.Mocked<YtMusicUnavailableRecoveryDependencies> => ({
        getStreamInfo: jest.fn(),
        findPlayableAlternate: jest.fn(),
        ensureRemoteTrack: jest.fn(),
        persistPlaylistReplacement: jest.fn(),
    });

const baseInput = {
    originalVideoId: "z0NfI2NeDHI",
    artist: "Rammstein",
    title: "Radio (Official Video)",
    albumTitle: "Rammstein",
    duration: 275,
    excludedVideoIds: ["z0NfI2NeDHI"],
    playlistItemId: "playlist-item-1",
    expectedTrackYtMusicId: "yt-row-original",
};

describe("YT Music unavailable recovery", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it.each([404, 451] as const)(
        "replaces an original %s only after a playable alternate was found",
        async (status) => {
            const deps = makeDependencies();
            deps.getStreamInfo.mockRejectedValueOnce(makeUnavailable(status));
            deps.findPlayableAlternate.mockResolvedValueOnce({
                videoId: "alternate02",
                title: "Radio",
                artist: "Rammstein",
                album: "Rammstein",
                duration: 274,
                thumbnailUrl: "https://img.invalid/radio.jpg",
            });
            deps.ensureRemoteTrack.mockResolvedValueOnce({
                id: "yt-row-alternate",
            });
            deps.persistPlaylistReplacement.mockResolvedValueOnce(true);
            const service = createYtMusicUnavailableRecoveryService(deps);

            await expect(service.recover("user-1", baseInput)).resolves.toEqual(
                {
                    status: "replaced",
                    originalVideoId: "z0NfI2NeDHI",
                    replacement: {
                        videoId: "alternate02",
                        title: "Radio",
                        duration: 274,
                        trackYtMusicId: "yt-row-alternate",
                    },
                    persisted: true,
                },
            );

            expect(deps.findPlayableAlternate).toHaveBeenCalledWith(
                "__public__",
                expect.objectContaining({
                    excludedVideoIds: ["z0NfI2NeDHI"],
                }),
            );
            expect(deps.persistPlaylistReplacement).toHaveBeenCalledWith({
                userId: "user-1",
                playlistItemId: "playlist-item-1",
                expectedTrackYtMusicId: "yt-row-original",
                replacementTrackYtMusicId: "yt-row-alternate",
            });
        },
    );

    it("keeps the existing player fallback when no validated candidate exists", async () => {
        const deps = makeDependencies();
        deps.getStreamInfo.mockRejectedValueOnce(makeUnavailable(451));
        deps.findPlayableAlternate.mockResolvedValueOnce(null);
        const service = createYtMusicUnavailableRecoveryService(deps);

        await expect(service.recover("user-1", baseInput)).resolves.toEqual({
            status: "no_candidate",
            originalVideoId: "z0NfI2NeDHI",
            replacement: null,
            persisted: false,
        });
        expect(deps.ensureRemoteTrack).not.toHaveBeenCalled();
        expect(deps.persistPlaylistReplacement).not.toHaveBeenCalled();
    });

    it("does not search when the original stream is currently available", async () => {
        const deps = makeDependencies();
        deps.getStreamInfo.mockResolvedValueOnce(undefined);
        const service = createYtMusicUnavailableRecoveryService(deps);

        await expect(service.recover("user-1", baseInput)).resolves.toEqual({
            status: "original_available",
            originalVideoId: "z0NfI2NeDHI",
            replacement: null,
            persisted: false,
        });
        expect(deps.findPlayableAlternate).not.toHaveBeenCalled();
    });

    it("singleflights identical requests and bounds distinct recoveries", async () => {
        const deps = makeDependencies();
        const releases: Array<() => void> = [];
        let active = 0;
        let maxActive = 0;
        deps.getStreamInfo.mockImplementation(
            () =>
                new Promise<void>((_resolve, reject) => {
                    active += 1;
                    maxActive = Math.max(maxActive, active);
                    releases.push(() => {
                        active -= 1;
                        reject(makeUnavailable(451));
                    });
                }),
        );
        deps.findPlayableAlternate.mockResolvedValue(null);
        const service = createYtMusicUnavailableRecoveryService(deps, {
            maxConcurrency: 2,
        });

        const sameA = service.recover("user-1", baseInput);
        const sameB = service.recover("user-1", baseInput);
        const second = service.recover("user-1", {
            ...baseInput,
            originalVideoId: "secondvid01",
            excludedVideoIds: ["secondvid01"],
        });
        const third = service.recover("user-1", {
            ...baseInput,
            originalVideoId: "thirdvideo1",
            excludedVideoIds: ["thirdvideo1"],
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(deps.getStreamInfo).toHaveBeenCalledTimes(2);
        expect(maxActive).toBe(2);

        releases.shift()?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(deps.getStreamInfo).toHaveBeenCalledTimes(3);

        releases.splice(0).forEach((release) => release());
        await Promise.all([sameA, sameB, second, third]);
        expect(deps.getStreamInfo).toHaveBeenCalledTimes(3);
        expect(maxActive).toBe(2);
    });
});

describe("playlist replacement persistence", () => {
    it("updates only the owned item that still references the expected row", async () => {
        const tx = {
            playlistItem: {
                findFirst: jest
                    .fn()
                    .mockResolvedValueOnce({ playlistId: "playlist-1" }),
                updateMany: jest.fn().mockResolvedValueOnce({ count: 1 }),
            },
        };
        const db = {
            $transaction: async <T>(
                callback: (client: typeof tx) => Promise<T>,
            ): Promise<T> => callback(tx),
        };

        await expect(
            persistPlaylistYtMusicReplacement(db, {
                userId: "user-1",
                playlistItemId: "item-1",
                expectedTrackYtMusicId: "old-row",
                replacementTrackYtMusicId: "new-row",
            }),
        ).resolves.toBe(true);

        expect(tx.playlistItem.findFirst).toHaveBeenNthCalledWith(1, {
            where: {
                id: "item-1",
                trackYtMusicId: "old-row",
                trackId: null,
                trackTidalId: null,
                playlist: { userId: "user-1" },
            },
            select: { playlistId: true },
        });
        expect(tx.playlistItem.updateMany).toHaveBeenCalledWith({
            where: {
                id: "item-1",
                playlistId: "playlist-1",
                trackYtMusicId: "old-row",
                trackId: null,
                trackTidalId: null,
            },
            data: { trackYtMusicId: "new-row" },
        });
    });

    it("updates the exact occurrence when the replacement exists elsewhere in the playlist", async () => {
        const tx = {
            playlistItem: {
                findFirst: jest
                    .fn()
                    .mockResolvedValueOnce({ playlistId: "playlist-1" })
                    .mockResolvedValueOnce({ id: "existing-item" }),
                updateMany: jest.fn().mockResolvedValueOnce({ count: 1 }),
            },
        };
        const db = {
            $transaction: async <T>(
                callback: (client: typeof tx) => Promise<T>,
            ): Promise<T> => callback(tx),
        };

        await expect(
            persistPlaylistYtMusicReplacement(db, {
                userId: "user-1",
                playlistItemId: "item-1",
                expectedTrackYtMusicId: "old-row",
                replacementTrackYtMusicId: "new-row",
            }),
        ).resolves.toBe(true);
        expect(tx.playlistItem.findFirst).toHaveBeenCalledTimes(1);
        expect(tx.playlistItem.updateMany).toHaveBeenCalledWith({
            where: {
                id: "item-1",
                playlistId: "playlist-1",
                trackYtMusicId: "old-row",
                trackId: null,
                trackTidalId: null,
            },
            data: { trackYtMusicId: "new-row" },
        });
    });
});
