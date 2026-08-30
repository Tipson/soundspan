import assert from "node:assert/strict";
import test from "node:test";
import type { PlaylistDetailTrackItem } from "../../lib/api";
import { selectPlaylistPlaybackQueue } from "../../lib/playlistItemPlayback";

function playableItem(
    id: string,
    trackId: string,
    sort: number,
): PlaylistDetailTrackItem {
    return {
        id,
        type: "track",
        sort,
        playback: { isPlayable: true, reason: null, message: null },
        track: {
            id: trackId,
            title: `Track ${trackId}`,
            duration: 180,
            album: {
                title: "Album",
                artist: { name: "Artist" },
            },
        },
    };
}

test("playlist row playback preserves playable visual order and starts at the selected row", () => {
    const first = playableItem("item-local", "local-1", 1);
    const unavailable: PlaylistDetailTrackItem = {
        id: "item-unavailable",
        type: "track",
        sort: 2,
        playback: {
            isPlayable: false,
            reason: "missing_provider_track",
            message: "Unavailable",
        },
        track: null,
    };
    const selected = playableItem("item-youtube", "yt:video-2", 3);
    selected.track!.streamSource = "youtube";
    selected.track!.youtubeVideoId = "video-2";
    const last = playableItem("item-tidal", "tidal:3", 4);
    last.track!.streamSource = "tidal";
    last.track!.tidalTrackId = 3;

    const selection = selectPlaylistPlaybackQueue(
        [first, unavailable, selected, last],
        selected.id,
    );

    assert.deepEqual(
        selection.tracks.map((track) => track.id),
        ["local-1", "yt:video-2", "tidal:3"],
    );
    assert.equal(selection.startIndex, 1);
});

test("playlist row playback returns no selection for an unavailable row", () => {
    const playable = playableItem("item-local", "local-1", 1);
    const unavailable: PlaylistDetailTrackItem = {
        id: "item-unavailable",
        type: "track",
        sort: 2,
        playback: {
            isPlayable: false,
            reason: "missing_provider_track",
            message: "Unavailable",
        },
        track: null,
    };

    assert.deepEqual(
        selectPlaylistPlaybackQueue([playable, unavailable], unavailable.id),
        { tracks: [], startIndex: -1 },
    );
});
