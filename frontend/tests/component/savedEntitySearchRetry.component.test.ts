import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useSavedEntitySearch } from "../../features/search/hooks/useSavedEntitySearch";
import { api } from "../../lib/api";

const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)(
    "@tanstack/react-query",
) as typeof import("@tanstack/react-query");

test("private retry recovers the failed raw continuation before clearing its notice", async () => {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const original = api.listSavedMusicEntities;
    const offsets: number[] = [];
    let unavailable = true;
    let value!: ReturnType<typeof useSavedEntitySearch>;
    function Probe() {
        value = useSavedEntitySearch("Кино", "album", true);
        return null;
    }
    function render() {
        renderToStaticMarkup(
            React.createElement(
                QueryClientProvider,
                { client },
                React.createElement(Probe),
            ),
        );
    }
    api.listSavedMusicEntities = async (params) => {
        const offset = params?.offset ?? 0;
        offsets.push(offset);
        if (offset === 50 && unavailable) throw new Error("Temporary failure");
        return {
            items: Array.from({ length: offset === 0 ? 50 : 1 }, (_, i) => ({
                id: `row-${offset + i}`,
                entityType: "album",
                source: "library",
                entityId: `album-${offset + i}`,
                title: "Кино",
                subtitle: null,
                imageUrl: null,
            })),
            total: 51,
            search: { query: "Кино", offset, limit: 50 },
        };
    };
    try {
        render();
        await value.refetch();
        render();
        await value.fetchNextPage();
        render();
        assert.equal(value.partial, true);
        assert.equal(value.items.length, 50);
        unavailable = false;
        await value.retry();
        render();
        assert.deepEqual(offsets, [0, 50, 50]);
        assert.equal(value.items.length, 51);
        assert.equal(value.partial, false);
        assert.equal(value.hasNextPage, false);
    } finally {
        api.listSavedMusicEntities = original;
        client.clear();
    }
});
