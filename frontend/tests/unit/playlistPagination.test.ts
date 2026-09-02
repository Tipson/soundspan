import assert from "node:assert/strict";
import test from "node:test";

import { mergePlaylistDetailPages } from "../../features/playlist/lib/playlistPagination";

test("mergePlaylistDetailPages keeps cursor page order and removes repeated boundary items", () => {
    const first = {
        id: "playlist-1",
        name: "Large playlist",
        isOwner: true,
        isHidden: false,
        isPublic: false,
        items: [
            { id: "track-1", type: "track" as const, sort: 1, track: null },
        ],
        pendingTracks: [],
        pendingCount: 1,
        totalItemCount: 3,
        mergedItems: [],
        pagination: { limit: 2, hasMore: true, nextCursor: "next" },
    };
    const second = {
        ...first,
        items: [
            { id: "track-1", type: "track" as const, sort: 1, track: null },
            { id: "track-3", type: "track" as const, sort: 3, track: null },
        ],
        pendingTracks: [
            {
                id: "pending-2",
                type: "pending" as const,
                sort: 2,
                pending: {
                    id: "pending-2",
                    artist: "Artist",
                    title: "Title",
                    album: "Album",
                    previewUrl: null,
                },
            },
        ],
        pagination: { limit: 2, hasMore: false, nextCursor: null },
    };

    const merged = mergePlaylistDetailPages([first, second]);

    assert.deepEqual(
        merged?.items.map((item) => item.id),
        ["track-1", "track-3"],
    );
    assert.deepEqual(
        merged?.pendingTracks.map((item) => item.id),
        ["pending-2"],
    );
    assert.equal(merged?.totalItemCount, 3);
});
