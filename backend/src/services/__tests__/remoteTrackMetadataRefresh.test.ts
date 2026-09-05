const mockPrisma = {
    trackYtMusic: {
        findMany: jest.fn(),
        update: jest.fn(),
    },
};

const mockLogger: Record<string, jest.Mock> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

jest.mock("../../utils/db", () => ({ prisma: mockPrisma }));
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));

const mockYtGetSong = jest.fn();
jest.mock("../youtubeMusic", () => ({
    ytMusicService: { getSong: mockYtGetSong },
}));

import { remoteTrackMetadataRefreshService } from "../remoteTrackMetadataRefresh";

describe("RemoteTrackMetadataRefreshService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockYtGetSong.mockReset();
        mockPrisma.trackYtMusic.findMany.mockReset().mockResolvedValue([]);
        mockPrisma.trackYtMusic.update.mockReset();
    });

    describe("refreshUnknownMetadata", () => {
        it("returns zero counts when no unknown rows exist", async () => {
            const result =
                await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(result).toEqual({ updated: 0, failed: 0 });
            expect(mockYtGetSong).not.toHaveBeenCalled();
        });

        it("queries YouTube Music placeholders with the requested batch size", async () => {
            await remoteTrackMetadataRefreshService.refreshUnknownMetadata(25);

            expect(mockPrisma.trackYtMusic.findMany).toHaveBeenCalledWith({
                where: {
                    OR: expect.arrayContaining([
                        {
                            album: {
                                in: expect.arrayContaining([
                                    "Unknown Album",
                                    "single",
                                ]),
                            },
                        },
                    ]),
                },
                select: { id: true, videoId: true },
                take: 25,
            });
        });

        it("refreshes a YouTube Music row through the public metadata lookup", async () => {
            mockPrisma.trackYtMusic.findMany.mockResolvedValueOnce([
                { id: "yt-1", videoId: "abc123" },
            ]);
            mockYtGetSong.mockResolvedValueOnce({
                videoId: "abc123",
                title: "Real YT Title",
                artist: "Real YT Artist",
                album: "Real YT Album",
                duration: 180,
            });

            const result =
                await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(mockYtGetSong).toHaveBeenCalledWith("__public__", "abc123");
            expect(mockPrisma.trackYtMusic.update).toHaveBeenCalledWith({
                where: { id: "yt-1" },
                data: {
                    title: "Real YT Title",
                    artist: "Real YT Artist",
                    album: "Real YT Album",
                    duration: 180,
                },
            });
            expect(result).toEqual({ updated: 1, failed: 0 });
        });

        it("writes only real fields from a partial YouTube Music response", async () => {
            mockPrisma.trackYtMusic.findMany.mockResolvedValueOnce([
                { id: "yt-partial", videoId: "partial" },
            ]);
            mockYtGetSong.mockResolvedValueOnce({
                title: "Real title",
                artist: "Unknown",
                album: "Single",
                duration: 0,
            });

            const result =
                await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(mockPrisma.trackYtMusic.update).toHaveBeenCalledWith({
                where: { id: "yt-partial" },
                data: { title: "Real title" },
            });
            expect(result).toEqual({ updated: 1, failed: 0 });
        });

        it("counts provider errors as failed", async () => {
            mockPrisma.trackYtMusic.findMany.mockResolvedValueOnce([
                { id: "yt-error", videoId: "error" },
            ]);
            mockYtGetSong.mockRejectedValueOnce(new Error("Network error"));

            const result =
                await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(result).toEqual({ updated: 0, failed: 1 });
            expect(mockPrisma.trackYtMusic.update).not.toHaveBeenCalled();
        });

        it("counts placeholder-only responses as failed", async () => {
            mockPrisma.trackYtMusic.findMany.mockResolvedValueOnce([
                { id: "yt-empty", videoId: "empty" },
            ]);
            mockYtGetSong.mockResolvedValueOnce({
                title: "Unknown",
                artist: "",
                album: "single",
            });

            const result =
                await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(result).toEqual({ updated: 0, failed: 1 });
            expect(mockPrisma.trackYtMusic.update).not.toHaveBeenCalled();
        });
    });
});
