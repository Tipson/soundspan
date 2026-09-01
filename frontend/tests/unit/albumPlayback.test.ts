import assert from "node:assert/strict";
import test from "node:test";
import {
    isAlbumTrackPlayable,
    selectAlbumPlaybackQueue,
    toAlbumPlaybackTrack,
} from "../../features/album/albumPlayback";

test("toAlbumPlaybackTrack preserves a YouTube album track thumbnail", () => {
    const playbackTrack = toAlbumPlaybackTrack(
        {
            id: "yt:video-1",
            title: "Remote Song",
            duration: 180,
            album: { coverArt: null },
            streamSource: "youtube",
            youtubeVideoId: "video-1",
            thumbnailUrl: "https://img.local/video-1.jpg",
        },
        {
            id: "album-1",
            title: "Remote Album",
            artist: { id: "artist-1", name: "Remote Artist" },
            coverArt: "https://img.local/album-fallback.jpg",
        },
    );

    assert.equal(playbackTrack.album.coverArt, "https://img.local/video-1.jpg");
    assert.equal(playbackTrack.youtubeVideoId, "video-1");
});

test("album queue selection removes offline peers and keeps the selected row index", () => {
    const album = {
        id: "album-queue",
        title: "Queue Album",
        artist: { id: "artist-1", name: "Artist" },
        owned: true,
        source: "local" as const,
        tracks: [
            { id: "track-1", title: "First", duration: 180 },
            {
                id: "peer-offline",
                title: "Offline",
                duration: 181,
                source: "federated" as const,
                peer: {
                    id: "peer-1",
                    name: "Offline peer",
                    baseUrl: "https://peer.invalid",
                    online: false,
                },
            },
            {
                id: "yt:selected",
                title: "Selected",
                duration: 182,
                streamSource: "youtube" as const,
                youtubeVideoId: "selected",
            },
        ],
    };

    const selection = selectAlbumPlaybackQueue(album, 2);

    assert.deepEqual(
        selection.tracks.map((track) => track.id),
        ["track-1", "yt:selected"],
    );
    assert.equal(selection.startIndex, 1);
    assert.equal(selection.tracks[1].youtubeVideoId, "selected");
});

test("discovery album playback excludes metadata and preview-only rows", () => {
    const album = {
        id: "discovery-album",
        title: "Discovery Album",
        artist: { id: "artist-1", name: "Artist" },
        owned: false,
        source: "local" as const,
        tracks: [
            { id: "metadata-only", title: "Metadata", duration: 180 },
            {
                id: "preview-only",
                title: "Preview",
                duration: 181,
                thumbnailUrl: "https://img.local/preview.jpg",
            },
            {
                id: "youtube:playable",
                title: "YouTube",
                duration: 182,
                streamSource: "youtube" as const,
                youtubeVideoId: "playable",
            },
            {
                id: "tidal:42",
                title: "Tidal",
                duration: 183,
                streamSource: "tidal" as const,
                tidalTrackId: 42,
            },
        ],
    };

    const selection = selectAlbumPlaybackQueue(album, 2);

    assert.deepEqual(
        selection.tracks.map((track) => track.id),
        ["youtube:playable", "tidal:42"],
    );
    assert.equal(selection.startIndex, 0);
});

test("album row and queue availability share one source-aware predicate", () => {
    const metadataTrack = {
        id: "metadata-only",
        title: "Metadata",
        duration: 180,
    };
    const youtubeTrack = {
        ...metadataTrack,
        id: "youtube:playable",
        streamSource: "youtube" as const,
        youtubeVideoId: "playable",
    };
    const youtubeMetadataTrack = {
        ...metadataTrack,
        id: "youtube:metadata",
        streamSource: "youtube" as const,
    };

    assert.equal(isAlbumTrackPlayable(metadataTrack, "discovery"), false);
    assert.equal(isAlbumTrackPlayable(metadataTrack, "library"), true);
    assert.equal(isAlbumTrackPlayable(youtubeTrack, "discovery"), true);
    assert.equal(
        isAlbumTrackPlayable(youtubeMetadataTrack, "discovery"),
        false,
    );
});
