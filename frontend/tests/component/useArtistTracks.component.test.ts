import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

interface InfiniteQueryOptions {
    enabled?: boolean;
    initialPageParam: number;
    queryFn: (context: { pageParam: number }) => Promise<unknown>;
    getNextPageParam: (page: {
        tracks: unknown[];
        total: number;
        offset: number;
        limit: number;
    }) => number | undefined;
}

const state = {
    options: null as InfiniteQueryOptions | null,
    apiCalls: [] as Array<{ id: string; limit?: number; offset?: number }>,
};

const reactQueryExports = {
    useInfiniteQuery: (options: InfiniteQueryOptions) => {
        state.options = options;
        return {
            data: {
                pages: [
                    {
                        tracks: [{ id: "track-1" }, { id: "track-2" }],
                        total: 3,
                        offset: 0,
                        limit: 2,
                    },
                ],
            },
            fetchNextPage: async () => undefined,
            hasNextPage: true,
            isFetchingNextPage: false,
            isLoading: false,
        };
    },
};

mock.module("@tanstack/react-query", {
    namedExports: reactQueryExports,
});
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
            artistTracks: (id: string) => ["artist", "tracks", id],
        },
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getArtistTracks: async (
                id: string,
                params: { limit?: number; offset?: number },
            ) => {
                state.apiCalls.push({ id, ...params });
                return {
                    tracks: [],
                    total: 0,
                    offset: params.offset ?? 0,
                    limit: params.limit ?? 100,
                };
            },
        },
    },
});

test("artist tracks hook exposes flattened pages and requests the next offset", async () => {
    const { useArtistTracks } =
        await import("../../features/artist/hooks/useArtistTracks");
    let captured!: ReturnType<typeof useArtistTracks>;
    const Probe = () => {
        captured = useArtistTracks("artist-1", true);
        return null;
    };

    renderToStaticMarkup(React.createElement(Probe));

    assert.deepEqual(captured.tracks, [{ id: "track-1" }, { id: "track-2" }]);
    assert.equal(state.options?.enabled, true);
    assert.equal(state.options?.initialPageParam, 0);
    assert.equal(
        state.options?.getNextPageParam({
            tracks: [{}, {}],
            total: 3,
            offset: 0,
            limit: 2,
        }),
        2,
    );
    assert.equal(
        state.options?.getNextPageParam({
            tracks: [{}],
            total: 3,
            offset: 2,
            limit: 2,
        }),
        undefined,
    );
    assert.equal(
        state.options?.getNextPageParam({
            tracks: [],
            total: 3,
            offset: 0,
            limit: 2,
        }),
        undefined,
    );
    await state.options?.queryFn({ pageParam: 200 });
    assert.deepEqual(state.apiCalls, [
        { id: "artist-1", limit: 100, offset: 200 },
    ]);
});
