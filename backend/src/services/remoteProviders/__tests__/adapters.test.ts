const mockYoutubeStream = jest.fn();
const mockYoutubePlaylist = jest.fn();
const mockFindTidal = jest.fn();
const mockFindYoutube = jest.fn();

jest.mock("../../youtubeMusic", () => ({
    ytMusicService: {
        getStreamProxy: mockYoutubeStream,
        getBrowsePlaylist: mockYoutubePlaylist,
    },
}));
jest.mock("../../../utils/db", () => ({
    prisma: {
        trackTidal: { findMany: mockFindTidal },
        trackYtMusic: { findMany: mockFindYoutube },
    },
}));

import { remoteProviderAdapters } from "../adapters";

describe("remote provider adapter table", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("keeps historical TIDAL rows readable without exposing runtime operations", async () => {
        const adapter = remoteProviderAdapters.tidal;
        mockFindTidal.mockResolvedValueOnce([]);

        await expect(
            adapter.streamTrack({
                userId: "user-1",
                tidalTrackId: 42,
                quality: "HIGH",
                range: "bytes=0-9",
            }),
        ).resolves.toBeNull();
        await expect(
            adapter.fetchPlaylist({
                sourceId: "playlist-1",
                userId: "user-1",
                authenticated: true,
                quality: "HIGH",
            }),
        ).rejects.toThrow("TIDAL provider has been retired");
        await adapter.findTracksByIds(["tidal-row-1"]);

        expect(mockFindTidal).toHaveBeenCalledWith({
            where: { id: { in: ["tidal-row-1"] } },
        });
    });

    it("routes YouTube operations to YouTube Music services", async () => {
        const adapter = remoteProviderAdapters.youtube;
        mockYoutubeStream.mockResolvedValueOnce(null);
        mockYoutubePlaylist.mockResolvedValueOnce({ title: "YT", tracks: [] });
        mockFindYoutube.mockResolvedValueOnce([]);

        await adapter.streamTrack({
            userId: "oauth-user",
            youtubeVideoId: "video-1",
            quality: "LOW",
        });
        await adapter.fetchPlaylist({
            sourceId: "playlist-2",
            userId: "oauth-user",
            authenticated: true,
            quality: "HIGH",
        });
        await adapter.findTracksByIds(["yt-row-1"]);

        expect(mockYoutubeStream).toHaveBeenCalledWith(
            "oauth-user",
            "video-1",
            "LOW",
            undefined,
        );
        expect(mockYoutubePlaylist).toHaveBeenCalledWith(
            "playlist-2",
            100,
            "oauth-user",
        );
        expect(mockFindYoutube).toHaveBeenCalledWith({
            where: { id: { in: ["yt-row-1"] } },
        });
    });
});
