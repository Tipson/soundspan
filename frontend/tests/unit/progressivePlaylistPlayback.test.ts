import assert from "node:assert/strict";
import test from "node:test";

import type {
    PlaylistDetailResponse,
    PlaylistDetailTrackItem,
    PlaylistPendingTrackItem,
} from "../../lib/api";
import {
    getPlaylistNextPageParam,
    mergePlaylistDetailPages,
} from "../../features/playlist/lib/playlistPagination";
import {
    playlistQueueEntryKey,
    playPlaylistProgressively,
} from "../../features/playlist/lib/progressivePlaylistPlayback";

type PlaylistEntry = PlaylistDetailTrackItem | PlaylistPendingTrackItem;

function playableEntry(
    position: number,
    options: { itemId?: string; trackId?: string } = {},
): PlaylistDetailTrackItem {
    const trackId = options.trackId ?? `track-${position}`;
    return {
        id: options.itemId ?? `item-${position}`,
        type: "track",
        sort: position,
        trackId,
        provider: { source: "local", label: "LOCAL" },
        playback: { isPlayable: true, reason: null, message: null },
        track: {
            id: trackId,
            title: `Track ${position}`,
            duration: 180,
            album: {
                id: `album-${position}`,
                title: `Album ${position}`,
                artist: { id: `artist-${position}`, name: "Artist" },
            },
        },
    };
}

function pendingEntry(position: number): PlaylistPendingTrackItem {
    return {
        id: `pending-${position}`,
        type: "pending",
        sort: position,
        pending: {
            id: `pending-${position}`,
            title: `Pending ${position}`,
            artist: "Artist",
            album: "Album",
            previewUrl: null,
        },
    };
}

function page(
    entries: PlaylistEntry[],
    options: {
        total?: number;
        hasMore?: boolean;
        nextCursor?: string | null;
    } = {},
): PlaylistDetailResponse {
    return {
        id: "playlist-large",
        name: "Large playlist",
        isOwner: true,
        isHidden: false,
        isPublic: false,
        items: entries.filter(
            (entry): entry is PlaylistDetailTrackItem => entry.type === "track",
        ),
        pendingTracks: entries.filter(
            (entry): entry is PlaylistPendingTrackItem =>
                entry.type === "pending",
        ),
        pendingCount: entries.filter((entry) => entry.type === "pending")
            .length,
        totalItemCount: options.total ?? entries.length,
        mergedItems: entries,
        pagination: {
            limit: 100,
            hasMore: options.hasMore ?? false,
            nextCursor: options.nextCursor ?? null,
        },
    };
}

function pagesForSize(size: number): PlaylistDetailResponse[] {
    const entries = Array.from({ length: size }, (_, index) =>
        playableEntry(index + 1),
    );
    const pages: PlaylistDetailResponse[] = [];
    for (let offset = 0; offset < entries.length; offset += 100) {
        const hasMore = offset + 100 < entries.length;
        pages.push(
            page(entries.slice(offset, offset + 100), {
                total: size,
                hasMore,
                nextCursor: hasMore ? `cursor-${offset + 100}` : null,
            }),
        );
    }
    return pages;
}

test("display merge has no 1000-item ceiling and preserves 1294 source positions", () => {
    const pages = pagesForSize(1_294);
    const merged = mergePlaylistDetailPages(pages);

    assert.equal(merged?.mergedItems?.length, 1_294);
    assert.equal(merged?.mergedItems?.[0]?.id, "item-1");
    assert.equal(merged?.mergedItems?.at(-1)?.id, "item-1294");
});

test("display merge keeps pending and playable rows in one stable sort order", () => {
    const merged = mergePlaylistDetailPages([
        page([
            playableEntry(4),
            pendingEntry(1),
            playableEntry(2),
            pendingEntry(3),
        ]),
    ]);

    assert.deepEqual(
        merged?.mergedItems?.map((entry) => `${entry.type}:${entry.sort}`),
        ["pending:1", "track:2", "pending:3", "track:4"],
    );
});

test("invalid or repeated next cursors stop infinite pagination", () => {
    const first = page([playableEntry(1)], {
        hasMore: true,
        nextCursor: "cursor-1",
    });

    assert.equal(getPlaylistNextPageParam(first, [first]), "cursor-1");
    assert.equal(
        getPlaylistNextPageParam(
            page([playableEntry(2)], {
                hasMore: true,
                nextCursor: null,
            }),
            [first],
        ),
        undefined,
    );
    const repeated = page([playableEntry(2)], {
        hasMore: true,
        nextCursor: "cursor-1",
    });
    assert.equal(
        getPlaylistNextPageParam(repeated, [first, repeated]),
        undefined,
    );
});

test("play all starts its first playable page before the 1294-item tail resolves", async () => {
    const pages = pagesForSize(1_294);
    let resolveFetch:
        | ((value: {
              data: { pages: PlaylistDetailResponse[] };
              hasNextPage: boolean;
          }) => void)
        | undefined;
    const pendingFetch = new Promise<{
        data: { pages: PlaylistDetailResponse[] };
        hasNextPage: boolean;
    }>((resolve) => {
        resolveFetch = resolve;
    });
    const played: string[][] = [];
    const appended: string[][] = [];
    let queueIds: string[] = [];

    const completion = playPlaylistProgressively({
        initialPages: [pages[0]],
        initialHasNextPage: true,
        fetchNextPage: () => pendingFetch,
        isCurrentIntent: () => true,
        getCurrentQueueKeys: () => queueIds,
        playTracks: (tracks) => {
            queueIds = tracks.map(playlistQueueEntryKey);
            played.push(tracks.map((track) => track.id));
        },
        appendTracks: (tracks) => {
            const ids = tracks.map((track) => track.id);
            queueIds = [...queueIds, ...tracks.map(playlistQueueEntryKey)];
            appended.push(ids);
        },
    });

    assert.equal(played.length, 1);
    assert.equal(played[0].length, 100);
    assert.equal(appended.length, 0);

    resolveFetch?.({
        data: { pages },
        hasNextPage: false,
    });
    assert.equal((await completion).status, "completed");
    assert.equal(queueIds.length, 1_294);
});

test("play all skips an initial pending-only page and starts on the first playable page", async () => {
    const first = page([pendingEntry(1)], {
        total: 3,
        hasMore: true,
        nextCursor: "cursor-1",
    });
    const second = page([playableEntry(2)], {
        total: 3,
        hasMore: true,
        nextCursor: "cursor-2",
    });
    let resolveTail:
        | ((value: {
              data: { pages: PlaylistDetailResponse[] };
              hasNextPage: boolean;
          }) => void)
        | undefined;
    let fetchCount = 0;
    let queueKeys: string[] = [];
    const played: string[][] = [];

    const completion = playPlaylistProgressively({
        initialPages: [first],
        initialHasNextPage: true,
        fetchNextPage: async () => {
            fetchCount += 1;
            if (fetchCount === 1) {
                return {
                    data: { pages: [first, second] },
                    hasNextPage: true,
                };
            }
            return new Promise((resolve) => {
                resolveTail = resolve;
            });
        },
        isCurrentIntent: () => true,
        getCurrentQueueKeys: () => queueKeys,
        playTracks: (tracks) => {
            queueKeys = tracks.map(playlistQueueEntryKey);
            played.push(tracks.map((track) => track.id));
        },
        appendTracks: () => undefined,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(played, [["track-2"]]);
    assert.equal(fetchCount, 2);

    resolveTail?.({
        data: {
            pages: [first, second, page([pendingEntry(3)], { total: 3 })],
        },
        hasNextPage: false,
    });
    assert.equal((await completion).status, "completed");
});

test("a new playback intent cannot be overwritten while pending-only pages resolve", async () => {
    const first = page([pendingEntry(1)], {
        total: 2,
        hasMore: true,
        nextCursor: "cursor-1",
    });
    const second = page([playableEntry(2)], { total: 2 });
    let resolveFetch:
        | ((value: {
              data: { pages: PlaylistDetailResponse[] };
              hasNextPage: boolean;
          }) => void)
        | undefined;
    let queueKeys = ["track:before"];
    let playbackKey: string | null = "track:before";
    let playCount = 0;

    const completion = playPlaylistProgressively({
        initialPages: [first],
        initialHasNextPage: true,
        fetchNextPage: () =>
            new Promise((resolve) => {
                resolveFetch = resolve;
            }),
        isCurrentIntent: () => true,
        getCurrentQueueKeys: () => queueKeys,
        getCurrentPlaybackKey: () => playbackKey,
        playTracks: () => {
            playCount += 1;
        },
        appendTracks: () => assert.fail("must not append"),
    });

    queueKeys = ["track:new-intent"];
    playbackKey = "track:new-intent";
    resolveFetch?.({
        data: { pages: [first, second] },
        hasNextPage: false,
    });

    assert.equal((await completion).status, "queue-changed");
    assert.equal(playCount, 0);
});

test("5000-position play all streams pages in order and preserves duplicate tracks", async () => {
    const pages = pagesForSize(5_000);
    pages[1] = page(
        [
            pages[0].items.at(-1)!,
            playableEntry(101, {
                itemId: "duplicate-position-101",
                trackId: "track-100",
            }),
            ...pages[1].items.slice(1),
        ],
        { total: 5_000, hasMore: true, nextCursor: "cursor-200" },
    );
    let fetchedPageCount = 1;
    const played: string[][] = [];
    const appended: string[][] = [];
    let queueIds: string[] = [];

    const result = await playPlaylistProgressively({
        initialPages: [pages[0]],
        initialHasNextPage: true,
        fetchNextPage: async () => {
            fetchedPageCount += 1;
            return {
                data: { pages: pages.slice(0, fetchedPageCount) },
                hasNextPage: fetchedPageCount < pages.length,
            };
        },
        isCurrentIntent: () => true,
        getCurrentQueueKeys: () => queueIds,
        playTracks: (tracks) => {
            queueIds = tracks.map(playlistQueueEntryKey);
            played.push(tracks.map((track) => track.id));
        },
        appendTracks: (tracks) => {
            const ids = tracks.map((track) => track.id);
            queueIds = [...queueIds, ...tracks.map(playlistQueueEntryKey)];
            appended.push(ids);
        },
    });

    assert.equal(result.status, "completed");
    assert.equal(played.length, 1);
    assert.equal(appended.length, 49);
    assert.equal(queueIds.length, 5_000);
    assert.equal(queueIds[99], "playlist-item:item-100");
    assert.equal(queueIds[100], "playlist-item:duplicate-position-101");
    assert.equal(queueIds.at(-1), "playlist-item:item-5000");
});

test("tail loading retries once without replaying the first page", async () => {
    const first = page([playableEntry(1)], {
        total: 2,
        hasMore: true,
        nextCursor: "cursor-1",
    });
    const second = page([playableEntry(2)], { total: 2 });
    let attempts = 0;
    let queueIds: string[] = [];
    const played: string[][] = [];

    const result = await playPlaylistProgressively({
        initialPages: [first],
        initialHasNextPage: true,
        fetchNextPage: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("temporary failure");
            return {
                data: { pages: [first, second] },
                hasNextPage: false,
            };
        },
        isCurrentIntent: () => true,
        getCurrentQueueKeys: () => queueIds,
        playTracks: (tracks) => {
            queueIds = tracks.map(playlistQueueEntryKey);
            played.push(tracks.map((track) => track.id));
        },
        appendTracks: (tracks) => {
            queueIds = [...queueIds, ...tracks.map(playlistQueueEntryKey)];
        },
    });

    assert.equal(result.status, "completed");
    assert.equal(attempts, 2);
    assert.equal(played.length, 1);
    assert.deepEqual(queueIds, [
        "playlist-item:item-1",
        "playlist-item:item-2",
    ]);
});

test("tail loading stops on a non-growing or backwards page sequence", async () => {
    const first = page([playableEntry(2)], {
        total: 2,
        hasMore: true,
        nextCursor: "cursor-1",
    });
    let queueKeys: string[] = [];

    const nonGrowing = await playPlaylistProgressively({
        initialPages: [first],
        initialHasNextPage: true,
        fetchNextPage: async () => ({
            data: { pages: [first] },
            hasNextPage: true,
        }),
        isCurrentIntent: () => true,
        getCurrentQueueKeys: () => queueKeys,
        playTracks: (tracks) => {
            queueKeys = tracks.map(playlistQueueEntryKey);
        },
        appendTracks: () => assert.fail("must not append"),
    });
    assert.equal(nonGrowing.status, "invalid-pagination");

    const backwards = page([playableEntry(1)], { total: 2 });
    const backwardsResult = await playPlaylistProgressively({
        initialPages: [first],
        initialHasNextPage: true,
        fetchNextPage: async () => ({
            data: { pages: [first, backwards] },
            hasNextPage: false,
        }),
        isCurrentIntent: () => true,
        getCurrentQueueKeys: () => queueKeys,
        playTracks: (tracks) => {
            queueKeys = tracks.map(playlistQueueEntryKey);
        },
        appendTracks: () => assert.fail("must not append"),
    });
    assert.equal(backwardsResult.status, "invalid-pagination");
});

test("play all reports a missing continuation cursor after starting loaded tracks", async () => {
    const invalid = page([playableEntry(1)], {
        total: 2,
        hasMore: true,
        nextCursor: null,
    });
    let queueKeys: string[] = [];
    let fetchCount = 0;

    const result = await playPlaylistProgressively({
        initialPages: [invalid],
        initialHasNextPage: false,
        fetchNextPage: async () => {
            fetchCount += 1;
            return { data: { pages: [invalid] }, hasNextPage: false };
        },
        isCurrentIntent: () => true,
        getCurrentQueueKeys: () => queueKeys,
        playTracks: (tracks) => {
            queueKeys = tracks.map(playlistQueueEntryKey);
        },
        appendTracks: () => assert.fail("must not append"),
    });

    assert.equal(result.status, "invalid-pagination");
    assert.equal(result.playableCount, 1);
    assert.equal(fetchCount, 0);
});

test("a manual queue replacement prevents a late tail from being appended", async () => {
    const first = page([playableEntry(1)], {
        total: 2,
        hasMore: true,
        nextCursor: "cursor-1",
    });
    const second = page([playableEntry(2)], { total: 2 });
    let resolveFetch:
        | ((value: {
              data: { pages: PlaylistDetailResponse[] };
              hasNextPage: boolean;
          }) => void)
        | undefined;
    let queueIds: string[] = [];
    let appendCount = 0;

    const completion = playPlaylistProgressively({
        initialPages: [first],
        initialHasNextPage: true,
        fetchNextPage: () =>
            new Promise((resolve) => {
                resolveFetch = resolve;
            }),
        isCurrentIntent: () => true,
        getCurrentQueueKeys: () => queueIds,
        playTracks: (tracks) => {
            queueIds = tracks.map(playlistQueueEntryKey);
        },
        appendTracks: () => {
            appendCount += 1;
        },
    });

    queueIds = ["manual-track"];
    resolveFetch?.({
        data: { pages: [first, second] },
        hasNextPage: false,
    });

    assert.equal((await completion).status, "queue-changed");
    assert.equal(appendCount, 0);
    assert.deepEqual(queueIds, ["manual-track"]);
});

test("a newer play intent cancels the previous tail without touching its queue", async () => {
    const first = page([playableEntry(1)], {
        total: 2,
        hasMore: true,
        nextCursor: "cursor-1",
    });
    const second = page([playableEntry(2)], { total: 2 });
    let current = true;
    let resolveFetch:
        | ((value: {
              data: { pages: PlaylistDetailResponse[] };
              hasNextPage: boolean;
          }) => void)
        | undefined;
    let queueIds: string[] = [];
    let appendCount = 0;

    const completion = playPlaylistProgressively({
        initialPages: [first],
        initialHasNextPage: true,
        fetchNextPage: () =>
            new Promise((resolve) => {
                resolveFetch = resolve;
            }),
        isCurrentIntent: () => current,
        getCurrentQueueKeys: () => queueIds,
        playTracks: (tracks) => {
            queueIds = tracks.map(playlistQueueEntryKey);
        },
        appendTracks: () => {
            appendCount += 1;
        },
    });

    current = false;
    queueIds = ["new-intent-track"];
    resolveFetch?.({
        data: { pages: [first, second] },
        hasNextPage: false,
    });

    assert.equal((await completion).status, "cancelled");
    assert.equal(appendCount, 0);
    assert.deepEqual(queueIds, ["new-intent-track"]);
});
