const mockSearch = jest.fn();
const mockGetRadio = jest.fn();
jest.mock("../youtubeMusic", () => ({
    ytMusicService: { searchCanonical: mockSearch, getRadio: mockGetRadio },
}));
jest.mock("../../utils/db", () => ({ prisma: {} }));
import { buildRemoteArtistRadio } from "../playlistRemoteRadio";

const song = (providerTrackId: string, artistName = "Artist") => ({
    providerTrackId,
    artistName,
    provider: "ytmusic",
    source: "youtube",
});
const recommendation = (videoId: string) => ({
    videoId,
    title: "Recommendation",
    artist: "Related Artist",
    artists: ["Related Artist"],
    artistId: "UC-related",
    albumId: "MPRE-album",
    album: "Album",
    duration: 180,
    thumbnailUrl: "https://example.com/cover.jpg",
});
beforeEach(() => {
    jest.resetAllMocks();
});

test("artist radio seeds only exact artist matches and retains provider metadata without local files", async () => {
    mockSearch.mockResolvedValue({
        results: [
            song("wrong000001", "Other Artist"),
            song("seed0000001", " ARTIST "),
            song("seed0000001"),
        ],
    });
    mockGetRadio.mockResolvedValue({
        tracks: [
            recommendation("seed0000001"),
            recommendation("next0000001"),
            recommendation("next0000001"),
        ],
    });
    const result = await buildRemoteArtistRadio("Artist", 25);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
        youtubeVideoId: "next0000001",
        streamSource: "youtube",
        title: "Recommendation",
        artist: { id: "UC-related", name: "Related Artist" },
        album: { id: "MPRE-album", title: "Album" },
    });
    expect(mockGetRadio).toHaveBeenCalledTimes(1);
    expect(mockGetRadio).toHaveBeenCalledWith("seed0000001", 25);
});

test("unrelated catalog results cannot become artist radio", async () => {
    mockSearch.mockResolvedValue({
        results: [song("wrong000001", "Other Artist")],
    });
    expect(await buildRemoteArtistRadio("Artist", 25)).toEqual([]);
    expect(mockGetRadio).not.toHaveBeenCalled();
});

test("artist radio is bounded to three unique valid video seeds and the requested queue size", async () => {
    mockSearch.mockResolvedValue({
        results: [
            song("bad"),
            ...[1, 2, 3, 4].map((n) => song(`seed000000${n}`)),
        ],
    });
    mockGetRadio.mockImplementation(async (seed: string) => ({
        tracks: [
            recommendation(seed.replace("seed", "next")),
            recommendation("shared00001"),
        ],
    }));
    const result = await buildRemoteArtistRadio("Artist", 2);
    expect(mockGetRadio).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(2);
});

test("provider failure is an error, while successful empty recommendations stay empty", async () => {
    mockSearch.mockResolvedValue({ results: [song("seed0000001")] });
    mockGetRadio.mockRejectedValue(new Error("provider unavailable"));
    await expect(buildRemoteArtistRadio("Artist", 25)).rejects.toThrow(
        "provider unavailable",
    );
    mockGetRadio.mockResolvedValue({ tracks: [] });
    expect(await buildRemoteArtistRadio("Artist", 25)).toEqual([]);
});

test("partial seed failures preserve successful genuine recommendations", async () => {
    mockSearch.mockResolvedValue({
        results: [song("seed0000001"), song("seed0000002")],
    });
    mockGetRadio
        .mockRejectedValueOnce(new Error("one seed failed"))
        .mockResolvedValueOnce({ tracks: [recommendation("next0000001")] });
    expect(await buildRemoteArtistRadio("Artist", 25)).toHaveLength(1);
});
