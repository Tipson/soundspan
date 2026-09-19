import assert from "node:assert/strict";
import test from "node:test";
import type { LikedPlaylistResponse, LikedPlaylistTrack } from "../../lib/api";
import { loadAllDeviceOfflineLikes } from "../../features/device-offline/likedAutomation";

test("automatic downloads follow the server cursor past the first page", async () => {
    const calls: unknown[] = [];
    const first = { id: "first" } as LikedPlaylistTrack;
    const second = { id: "second" } as LikedPlaylistTrack;
    const result = await loadAllDeviceOfflineLikes(
        async (params) => {
            calls.push(params);
            return {
                tracks: calls.length === 1 ? [first] : [second],
                pagination: {
                    hasMore: calls.length === 1,
                    nextCursor:
                        calls.length === 1
                            ? { likedAt: "2026-09-10", trackId: "first" }
                            : null,
                },
            } as LikedPlaylistResponse;
        },
        () => true,
    );
    assert.deepEqual(result, [first, second]);
    assert.deepEqual(calls[1], {
        limit: 500,
        cursorLikedAt: "2026-09-10",
        cursorTrackId: "first",
    });
});

test("pagination rejects repeated cursors and never publishes a partial list after auth changes", async () => {
    const page = {
        tracks: [],
        pagination: {
            hasMore: true,
            nextCursor: { likedAt: "2026-09-10", trackId: "first" },
        },
    } as unknown as LikedPlaylistResponse;
    await assert.rejects(
        loadAllDeviceOfflineLikes(
            async () => page,
            () => true,
        ),
        /курсор/i,
    );
    let current = true;
    await assert.rejects(
        loadAllDeviceOfflineLikes(
            async () => {
                current = false;
                return page;
            },
            () => current,
        ),
        /сеанс/i,
    );
});
