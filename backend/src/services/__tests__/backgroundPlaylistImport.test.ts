const mockPrisma = {
    $transaction: jest.fn(),
    importJob: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
    },
    playlist: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
    },
    playlistPendingTrack: {
        createMany: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    playlistItem: {
        createMany: jest.fn(),
    },
};

const mockTrackMappingService = {
    createMapping: jest.fn(),
};
const mockCanonicalIdentityResolver = {
    resolveProviderTrack: jest.fn(),
};
const mockPersistImportedProviderIdentity = jest.fn();

jest.mock("../../utils/db", () => ({ prisma: mockPrisma }));
jest.mock("../../utils/logger", () => ({
    logger: {
        child: () => ({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        }),
    },
}));
jest.mock("../trackMappingService", () => ({
    trackMappingService: mockTrackMappingService,
}));
jest.mock("../recommendations/canonicalIdentity", () => ({
    canonicalIdentityResolver: mockCanonicalIdentityResolver,
}));
jest.mock("../recommendations/durableIdentityPersistence", () => ({
    persistImportedProviderIdentity: mockPersistImportedProviderIdentity,
}));

import { backgroundPlaylistImport } from "../backgroundPlaylistImport";

describe("background playlist import persistence", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        mockPrisma.$transaction.mockImplementation(async (callback: any) =>
            callback(mockPrisma),
        );
        mockPrisma.playlist.findUnique.mockResolvedValue(null);
        mockPrisma.playlist.findFirst.mockResolvedValue({ id: "playlist-1" });
        mockPrisma.playlist.create.mockResolvedValue({ id: "playlist-1" });
        mockPrisma.playlistPendingTrack.createMany.mockImplementation(
            async ({ data }: { data: unknown[] }) => ({ count: data.length }),
        );
        mockPrisma.playlistPendingTrack.findMany.mockImplementation(
            async ({ where }: { where: { sort: { in: number[] } } }) =>
                where.sort.in.map((sort) => ({ sort })),
        );
        mockPrisma.playlistPendingTrack.deleteMany.mockResolvedValue({
            count: 1,
        });
        mockPrisma.playlistItem.createMany.mockImplementation(
            async ({ data }: { data: unknown[] }) => ({ count: data.length }),
        );
        mockPrisma.importJob.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.importJob.findUnique.mockResolvedValue({
            resolutionAttempt: 1,
        });
        mockTrackMappingService.createMapping.mockResolvedValue({
            id: "mapping-1",
        });
        mockCanonicalIdentityResolver.resolveProviderTrack.mockResolvedValue({
            id: "canonical-1",
            canonicalKey: "isrc:USRC17607839",
        });
    });

    it("atomically creates a visible playlist shell with every source occurrence", async () => {
        const tracks = [0, 1].map((index) => ({
            index,
            artist: "Same Artist",
            title: "Same Song",
            album: "Same Album",
            duration: 180,
            isrc: "DUPLICATE-ISRC",
            source: "unresolved" as const,
            confidence: 0,
        }));

        await expect(
            backgroundPlaylistImport.initialize({
                jobId: "job-1",
                userId: "user-1",
                playlistName: "Imported Mix",
                tracks,
            }),
        ).resolves.toEqual({
            playlistId: "playlist-1",
            resolutionAttempt: 1,
        });

        expect(mockPrisma.playlistPendingTrack.createMany).toHaveBeenCalledWith(
            {
                data: [
                    expect.objectContaining({
                        playlistId: "playlist-1",
                        spotifyArtist: "Same Artist",
                        spotifyTitle: "Same Song",
                        spotifyAlbum: "Same Album",
                        sort: 0,
                    }),
                    expect.objectContaining({
                        playlistId: "playlist-1",
                        spotifyArtist: "Same Artist",
                        spotifyTitle: "Same Song",
                        spotifyAlbum: "Same Album",
                        sort: 1,
                    }),
                ],
            },
        );
        expect(mockPrisma.importJob.updateMany).toHaveBeenCalledWith({
            where: {
                id: "job-1",
                userId: "user-1",
                status: "resolving",
            },
            data: expect.objectContaining({
                playlistName: "Imported Mix",
                progress: 25,
                createdPlaylistId: "playlist-1",
                resolvedTracks: tracks,
                resolutionAttempt: { increment: 1 },
                resolutionProcessed: 0,
                summary: {
                    total: 2,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 2,
                },
            }),
        });
    });

    it("rejects a source snapshot whose array order does not match its positions", async () => {
        await expect(
            backgroundPlaylistImport.initialize({
                jobId: "job-1",
                userId: "user-1",
                playlistName: "Broken order",
                tracks: [
                    {
                        index: 1,
                        artist: "Artist",
                        title: "Song",
                        source: "unresolved",
                        confidence: 0,
                    },
                ],
            }),
        ).rejects.toThrow("contiguous ordered integers");

        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it("replaces only newly resolved placeholders at their original positions", async () => {
        const resolvedTrack = {
            index: 7,
            artist: "Artist",
            title: "Song",
            source: "youtube" as const,
            confidence: 85,
            trackYtMusicId: "yt-row-1",
        };
        const summary = {
            total: 10,
            local: 0,
            youtube: 1,
            tidal: 0,
            unresolved: 9,
        };

        await expect(
            backgroundPlaylistImport.persistResolution({
                jobId: "job-1",
                userId: "user-1",
                playlistId: "playlist-1",
                expectedResolutionAttempt: 1,
                newlyResolved: [resolvedTrack],
                snapshot: [resolvedTrack],
                summary,
                progress: 48,
                resolutionProcessed: 4,
            }),
        ).resolves.toBe(true);

        expect(mockPrisma.playlistItem.createMany).toHaveBeenCalledWith({
            data: [
                {
                    playlistId: "playlist-1",
                    trackId: null,
                    trackTidalId: null,
                    trackYtMusicId: "yt-row-1",
                    sort: 7,
                },
            ],
            skipDuplicates: true,
        });
        expect(mockPrisma.playlistPendingTrack.deleteMany).toHaveBeenCalledWith(
            {
                where: {
                    playlistId: "playlist-1",
                    sort: { in: [7] },
                },
            },
        );
        expect(mockPrisma.importJob.updateMany).toHaveBeenCalledWith({
            where: {
                id: "job-1",
                userId: "user-1",
                status: "resolving",
                createdPlaylistId: "playlist-1",
                resolutionAttempt: 1,
            },
            data: {
                progress: 48,
                summary,
                resolvedTracks: [resolvedTrack],
                resolutionProcessed: 4,
            },
        });
        expect(mockTrackMappingService.createMapping).toHaveBeenCalledWith({
            trackId: undefined,
            trackTidalId: undefined,
            trackYtMusicId: "yt-row-1",
            confidence: 0.85,
            source: "import-match",
        });
    });

    it("preserves a Spotify ISRC on the resolved YouTube provider mapping", async () => {
        const resolvedTrack = {
            index: 0,
            artist: "Imported artist",
            title: "Imported song",
            album: "Imported album",
            duration: 181,
            isrc: "USRC17607839",
            source: "youtube" as const,
            confidence: 85,
            trackYtMusicId: "yt-row-1",
            videoId: "youtube-video-1",
        };

        await backgroundPlaylistImport.persistResolution({
            jobId: "job-1",
            userId: "user-1",
            playlistId: "playlist-1",
            expectedResolutionAttempt: 1,
            newlyResolved: [resolvedTrack],
            snapshot: [resolvedTrack],
            summary: {
                total: 1,
                local: 0,
                youtube: 1,
                tidal: 0,
                unresolved: 0,
            },
            progress: 100,
            resolutionProcessed: 1,
        });

        expect(
            mockCanonicalIdentityResolver.resolveProviderTrack,
        ).toHaveBeenCalledWith({
            source: "youtube",
            providerTrackId: "youtube-video-1",
            title: "Imported song",
            artist: "Imported artist",
            album: "Imported album",
            duration: 181,
            isrc: "USRC17607839",
        });
        expect(mockPersistImportedProviderIdentity).toHaveBeenCalledWith(
            expect.objectContaining({
                source: "youtube",
                providerTrackId: "youtube-video-1",
                isrc: "USRC17607839",
            }),
            {
                id: "canonical-1",
                canonicalKey: "isrc:USRC17607839",
            },
        );
    });

    it("rolls back item publication when cancellation wins the job fence", async () => {
        mockPrisma.importJob.updateMany.mockResolvedValueOnce({ count: 0 });

        await expect(
            backgroundPlaylistImport.persistResolution({
                jobId: "job-1",
                userId: "user-1",
                playlistId: "playlist-1",
                expectedResolutionAttempt: 1,
                newlyResolved: [],
                snapshot: [],
                summary: {
                    total: 1,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 1,
                },
                progress: 40,
                resolutionProcessed: 0,
            }),
        ).resolves.toBe(false);

        expect(mockPrisma.playlistItem.createMany).not.toHaveBeenCalled();
        expect(
            mockPrisma.playlistPendingTrack.deleteMany,
        ).not.toHaveBeenCalled();
    });

    it("keeps the placeholder when a resolved batch has no matching provider identity", async () => {
        await expect(
            backgroundPlaylistImport.persistResolution({
                jobId: "job-1",
                userId: "user-1",
                playlistId: "playlist-1",
                expectedResolutionAttempt: 1,
                newlyResolved: [
                    {
                        index: 0,
                        artist: "Artist",
                        title: "Broken match",
                        source: "youtube",
                        confidence: 85,
                    },
                ],
                snapshot: [],
                summary: {
                    total: 1,
                    local: 0,
                    youtube: 1,
                    tidal: 0,
                    unresolved: 0,
                },
                progress: 48,
                resolutionProcessed: 1,
            }),
        ).rejects.toThrow("provider identity");

        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(mockPrisma.playlistItem.createMany).not.toHaveBeenCalled();
        expect(
            mockPrisma.playlistPendingTrack.deleteMany,
        ).not.toHaveBeenCalled();
    });

    it("does not restore a pending position removed by the user while resolution was running", async () => {
        mockPrisma.playlistPendingTrack.findMany.mockResolvedValueOnce([]);
        const resolvedTrack = {
            index: 3,
            artist: "Artist",
            title: "Removed Song",
            source: "youtube" as const,
            confidence: 85,
            trackYtMusicId: "yt-row-removed",
        };

        await expect(
            backgroundPlaylistImport.persistResolution({
                jobId: "job-1",
                userId: "user-1",
                playlistId: "playlist-1",
                expectedResolutionAttempt: 1,
                newlyResolved: [resolvedTrack],
                snapshot: [resolvedTrack],
                summary: {
                    total: 1,
                    local: 0,
                    youtube: 1,
                    tidal: 0,
                    unresolved: 0,
                },
                progress: 68,
                resolutionProcessed: 1,
            }),
        ).resolves.toBe(true);

        expect(mockPrisma.playlistItem.createMany).not.toHaveBeenCalled();
        expect(
            mockPrisma.playlistPendingTrack.deleteMany,
        ).not.toHaveBeenCalled();
    });
});
