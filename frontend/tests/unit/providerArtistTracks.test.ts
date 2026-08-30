import assert from "node:assert/strict";
import test from "node:test";
import {
    advanceProviderReleaseCount,
    mergeProviderAlbumTracks,
} from "../../features/artist/providerArtistTracks";

test("provider artist tracks merge every loaded album and single without duplicates", () => {
    const tracks = mergeProviderAlbumTracks([
        {
            browseId: "album-1",
            title: "Album",
            artist: "Artist",
            coverUrl: "album.jpg",
            tracks: [
                { videoId: "song-1", title: "First", duration_seconds: 180 },
                { videoId: "shared", title: "Shared", duration_seconds: 200 },
            ],
        },
        {
            browseId: "single-1",
            title: "Single",
            artist: "Artist",
            coverUrl: "single.jpg",
            tracks: [
                { videoId: "shared", title: "Shared", duration_seconds: 200 },
                { videoId: "song-2", title: "Second", duration_seconds: 210 },
            ],
        },
    ]);

    assert.deepEqual(
        tracks.map((track) => track.youtubeVideoId),
        ["song-1", "shared", "song-2"],
    );
    assert.equal(tracks[2]?.album?.title, "Single");
    assert.equal(tracks[2]?.streamSource, "youtube");
});

test("provider release batches advance progressively without skipping the tail", () => {
    assert.equal(advanceProviderReleaseCount(4, 10, 4), 8);
    assert.equal(advanceProviderReleaseCount(8, 10, 4), 10);
    assert.equal(advanceProviderReleaseCount(10, 10, 4), 10);
});
