import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

interface InfiniteQueryOptions {
    enabled?: boolean;
    initialPageParam: number;
    queryFn: (context: {
        pageParam: number;
        signal?: AbortSignal;
    }) => Promise<unknown>;
    getNextPageParam: (
        page: {
            tracks?: unknown[];
            streamingPage?: { offset: number; limit: number; hasMore: boolean };
        },
        pages: unknown[],
    ) => number | undefined;
}

const state = {
    options: null as InfiniteQueryOptions | null,
    calls: [] as Array<{ limit: number; offset: number }>,
    pages: [
        { tracks: [{ id: "track-1" }] },
        { tracks: [{ id: "track-2" }] },
    ] as Array<{
        tracks: { id: string }[];
        streamingTracks?: unknown[];
        streamingUnavailable?: boolean;
    }>,
};

const reactQueryExports = {
    useInfiniteQuery: (options: InfiniteQueryOptions) => {
        state.options = options;
        return {
            data: {
                pages: state.pages,
            },
            fetchNextPage: async () => undefined,
            hasNextPage: true,
            isFetchingNextPage: false,
            isLoading: false,
            isFetching: false,
        };
    },
};

mock.module("@tanstack/react-query", { namedExports: reactQueryExports });
mock.module(
    new URL(
        "../../node_modules/@tanstack/react-query/build/modern/index.cjs",
        import.meta.url,
    ).href,
    { namedExports: reactQueryExports },
);
mock.module("@/lib/queryKeys", {
    namedExports: {
        queryKeys: {
            searchTracks: (query: string, source: string) => [
                "search",
                "tracks",
                query,
                source,
            ],
        },
    },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            search: async (
                _query: string,
                _type: string,
                limit: number,
                _signal: AbortSignal | undefined,
                _source: string,
                offset: number,
            ) => {
                state.calls.push({ limit, offset });
                return { tracks: [] };
            },
        },
    },
});

test("library track search follows the backend offset until a short page", async () => {
    const { useLibraryTrackSearch, LIBRARY_TRACK_SEARCH_PAGE_SIZE } =
        await import("../../features/search/hooks/useLibraryTrackSearch");
    let result!: ReturnType<typeof useLibraryTrackSearch>;
    const Probe = () => {
        result = useLibraryTrackSearch("linkin park", "all", true);
        return null;
    };

    renderToStaticMarkup(React.createElement(Probe));

    assert.deepEqual(result.tracks, [{ id: "track-1" }, { id: "track-2" }]);
    assert.equal(state.options?.initialPageParam, 0);
    assert.equal(
        state.options?.getNextPageParam(
            { tracks: Array.from({ length: LIBRARY_TRACK_SEARCH_PAGE_SIZE }) },
            [{}, {}],
        ),
        LIBRARY_TRACK_SEARCH_PAGE_SIZE * 2,
    );
    assert.equal(
        state.options?.getNextPageParam({ tracks: [{}] }, [{}]),
        undefined,
    );
    await state.options?.queryFn({ pageParam: 100 });
    assert.deepEqual(state.calls, [
        { limit: LIBRARY_TRACK_SEARCH_PAGE_SIZE, offset: 100 },
    ]);
});

beforeEach(() => {
    state.calls = [];
    state.pages = [
        { tracks: [{ id: "track-1" }] },
        { tracks: [{ id: "track-2" }] },
    ];
});

test("an empty personal raw window with more matches still advances by the raw page size", async () => {
    const { useLibraryTrackSearch } =
        await import("../../features/search/hooks/useLibraryTrackSearch");
    state.pages = [
        { tracks: [], streamingTracks: [{ id: "saved-1" }] },
        { tracks: [], streamingTracks: [], streamingUnavailable: true },
    ];
    let result!: ReturnType<typeof useLibraryTrackSearch>;
    function Probe() {
        result = useLibraryTrackSearch("saved", "all", true);
        return null;
    }
    renderToStaticMarkup(React.createElement(Probe));
    assert.deepEqual(result.streamingTracks, [{ id: "saved-1" }]);
    assert.equal(result.streamingUnavailable, true);
    assert.equal(
        state.options?.getNextPageParam(
            {
                tracks: [],
                streamingPage: { offset: 50, limit: 50, hasMore: true },
            },
            [{}, {}],
        ),
        100,
    );
    assert.equal(
        state.options?.getNextPageParam(
            {
                tracks: [],
                streamingPage: { offset: 0, limit: 50, hasMore: true },
            },
            [{}, {}],
        ),
        undefined,
    );
    assert.equal(
        state.options?.getNextPageParam(
            {
                tracks: [],
                streamingPage: { offset: 50, limit: 100, hasMore: true },
            },
            [{}, {}],
        ),
        undefined,
    );
});
