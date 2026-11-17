import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SavedEntitySearchPage } from "../../features/search/savedEntitySearch";

interface Options {
    enabled: boolean;
    queryKey: readonly unknown[];
    queryFn: (value: {
        pageParam: number;
        signal: AbortSignal;
    }) => Promise<SavedEntitySearchPage>;
    getNextPageParam: (page: SavedEntitySearchPage) => number | undefined;
}
const item = {
    id: "saved-1",
    entityType: "album" as const,
    source: "ytmusic",
    entityId: "MPREb_1",
    title: "Album",
    subtitle: "Artist",
    imageUrl: null,
};
const state = {
    options: null as Options | null,
    pages: [] as SavedEntitySearchPage[],
    isError: false,
    reply: null as unknown,
    calls: [] as Array<{
        type: string;
        q: string;
        offset: number;
        signal: AbortSignal;
    }>,
};
const queryExports = {
    useInfiniteQuery: (options: Options) => {
        state.options = options;
        return {
            data: { pages: state.pages },
            hasNextPage: true,
            isLoading: false,
            isFetching: false,
            isFetchingNextPage: false,
            isError: state.isError,
            fetchNextPage: async () => undefined,
            refetch: async () => undefined,
        };
    },
};
mock.module("@tanstack/react-query", { namedExports: queryExports });
mock.module(
    new URL(
        "../../node_modules/@tanstack/react-query/build/modern/index.cjs",
        import.meta.url,
    ).href,
    { namedExports: queryExports },
);
mock.module("@/lib/api", {
    namedExports: {
        api: {
            listSavedMusicEntities: async (
                params: { type: string; q: string; offset: number },
                signal: AbortSignal,
            ) => {
                state.calls.push({ ...params, signal });
                return state.reply;
            },
        },
    },
});

beforeEach(() => {
    state.pages = [
        { items: [item], total: 1, nextOffset: undefined, partial: false },
    ];
    state.isError = false;
    state.calls = [];
    state.reply = null;
});

async function render(enabled: boolean, type: "album" | "artist" = "album") {
    const { useSavedEntitySearch } =
        await import("../../features/search/hooks/useSavedEntitySearch");
    let result!: ReturnType<typeof useSavedEntitySearch>;
    function Probe() {
        result = useSavedEntitySearch("  Кино  ", type, enabled);
        return null;
    }
    renderToStaticMarkup(React.createElement(Probe));
    return result;
}

test("disabled category cannot contribute cached matches or failures to the active tab", async () => {
    state.isError = true;
    const result = await render(false);
    assert.deepEqual(result.items, []);
    assert.equal(result.partial, false);
    assert.equal(result.hasNextPage, false);
});

test("saved query uses the API page echo and independent type/offset/signal", async () => {
    await render(true, "artist");
    state.reply = {
        items: [{ ...item, entityType: "artist" }],
        total: 51,
        search: { query: "Кино", offset: 50, limit: 50 },
    };
    const signal = new AbortController().signal;
    const page = await state.options!.queryFn({ pageParam: 50, signal });
    assert.equal(page.items[0].entityType, "artist");
    assert.equal(page.nextOffset, undefined);
    assert.deepEqual(state.calls, [
        { type: "artist", q: "Кино", offset: 50, signal, limit: 50 },
    ]);
    state.reply = { items: [item], total: 1 };
    await assert.rejects(state.options!.queryFn({ pageParam: 0, signal }));
});

test("private partial failure retains earlier matches and the raw continuation", async () => {
    state.pages = [{ items: [item], total: 51, nextOffset: 50, partial: true }];
    state.isError = true;
    const result = await render(true);
    assert.deepEqual(result.items, [item]);
    assert.equal(result.partial, true);
    assert.equal(state.options!.getNextPageParam(state.pages[0]), 50);
});
