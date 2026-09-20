const mockGetRadio = jest.fn();
jest.mock("../youtubeMusic", () => ({
    ytMusicService: { getRadio: mockGetRadio },
}));
const mockLikedFindMany = jest.fn();
jest.mock("../../utils/db", () => ({
    prisma: { likedRemoteTrack: { findMany: mockLikedFindMany } },
}));
import {
    buildRemoteTrackRadio,
    buildRemoteLikedRadio,
} from "../playlistRemoteRadio";
describe("track-seeded remote radio", () => {
    it("keeps playable provider metadata and excludes seed and duplicate videos", async () => {
        const row = (videoId: string) => ({
            videoId,
            title: videoId,
            artist: "Artist",
            album: "Album",
            duration: 180,
        });
        mockGetRadio.mockResolvedValue({
            tracks: [row("seed"), row("next"), row("next")],
        });
        const tracks = await buildRemoteTrackRadio("seed", 25);
        expect(mockGetRadio).toHaveBeenCalledWith("seed", 25);
        expect(tracks).toHaveLength(1);
        expect(tracks[0]).toMatchObject({
            youtubeVideoId: "next",
            streamSource: "youtube",
        });
    });
    it("does not pretend a seed-only result is a station", async () => {
        mockGetRadio.mockResolvedValue({ tracks: [{ videoId: "seed" }] });
        expect(await buildRemoteTrackRadio("seed", 25)).toEqual([]);
    });
    it("propagates provider errors", async () => {
        mockGetRadio.mockRejectedValue(new Error("provider unavailable"));
        await expect(buildRemoteTrackRadio("seed", 25)).rejects.toThrow(
            "provider unavailable",
        );
    });
});

test("liked radio uses only this user's remote liked seeds and deduplicates recommendations", async () => {
    mockLikedFindMany.mockResolvedValue([
        { trackYtMusic: { videoId: "seed" } },
    ]);
    mockGetRadio.mockResolvedValue({
        tracks: [
            {
                videoId: "next",
                title: "Next",
                artist: "Artist",
                album: "Album",
                duration: 180,
            },
        ],
    });
    const tracks = await buildRemoteLikedRadio("user-one", 25);
    expect(mockLikedFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
            where: { userId: "user-one", trackYtMusicId: { not: null } },
            take: 3,
        }),
    );
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ youtubeVideoId: "next" });
});
