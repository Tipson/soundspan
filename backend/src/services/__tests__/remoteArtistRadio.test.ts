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

test("refreshes only the three exact artist seed pools while preserving partial successes", async () => {
    mockSearch.mockResolvedValue({
        results: [
            song("wrong000001", "Other Artist"),
            ...[1, 2, 3, 4].map((n) => song(`seed000000${n}`)),
        ],
    });
    mockGetRadio.mockImplementation(async (seed: string) => {
        if (seed === "seed0000002") throw new Error("private-provider-error");
        return { tracks: [recommendation(seed.replace("seed", "next"))] };
    });
    const onPartialFailure = jest.fn();
    const result = await buildRemoteArtistRadio(
        "Artist",
        100,
        onPartialFailure,
        { refresh: true },
    );
    expect(mockGetRadio.mock.calls).toEqual(
        [1, 2, 3].map((n) => [`seed000000${n}`, 100, { refresh: true }]),
    );
    expect(result.map((track) => track.youtubeVideoId)).toEqual([
        "next0000001",
        "next0000003",
    ]);
    expect(onPartialFailure).toHaveBeenCalledTimes(1);
    expect(onPartialFailure).toHaveBeenCalledWith();
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

test("continuation observes a partial source failure without receiving provider errors", async () => {
    mockSearch.mockResolvedValue({
        results: [song("seed0000001"), song("seed0000002")],
    });
    mockGetRadio
        .mockRejectedValueOnce(new Error("private-token-in-provider-url"))
        .mockResolvedValueOnce({ tracks: [recommendation("next0000001")] });
    const onPartialFailure = jest.fn();
    expect(
        await buildRemoteArtistRadio("Artist", 25, onPartialFailure),
    ).toHaveLength(1);
    expect(onPartialFailure).toHaveBeenCalledTimes(1);
    expect(onPartialFailure).toHaveBeenCalledWith();
});

test("successful empty artist seeds do not report a provider failure", async () => {
    mockSearch.mockResolvedValue({
        results: [song("seed0000001"), song("seed0000002")],
    });
    mockGetRadio.mockResolvedValue({ tracks: [] });
    const onPartialFailure = jest.fn();
    expect(
        await buildRemoteArtistRadio("Artist", 25, onPartialFailure),
    ).toEqual([]);
    expect(onPartialFailure).not.toHaveBeenCalled();
});
