import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys, useSearchQuery } from "../../hooks/useQueries";
import { useSearchData } from "../../features/search/hooks/useSearchData";

test("a private read failure stays stale while a complete search keeps its cache", () => {
    for (const streamingUnavailable of [true, false]) {
        const client = new QueryClient({
            defaultOptions: { queries: { gcTime: Infinity } },
        });
        try {
            client.setQueryData(queryKeys.search("saved", "all", 20, "all"), {
                tracks: [],
                streamingUnavailable,
            });
            let stale: boolean | undefined;
            function Probe() {
                stale = useSearchQuery("saved", "all", 20).isStale;
                return null;
            }
            renderToStaticMarkup(
                React.createElement(
                    QueryClientProvider,
                    { client },
                    React.createElement(Probe),
                ),
            );
            assert.equal(stale, streamingUnavailable);
        } finally {
            client.clear();
        }
    }
});

test("retrying unavailable personal matches refetches their owner read and retains other results", async () => {
    const client = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });
    const original = {
        search: api.search,
        discover: api.discoverSearch,
        native: api.searchMusicSourceCatalog,
    };
    const local = { id: "local-1", title: "Local track" };
    let personalReads = 0;
    let value!: ReturnType<typeof useSearchData>;
    try {
        client.setQueryData(queryKeys.search("saved", "all", 20, "all"), {
            tracks: [local],
            streamingTracks: [],
            streamingUnavailable: true,
        });
        client.setQueryData(
            queryKeys.discoverSearch("saved", "music", 20, "all"),
            { results: [], aliasInfo: null },
        );
        client.setQueryData(queryKeys.serviceCatalog("saved"), {
            tracks: [],
            unavailable: [],
        });
        api.search = async () => {
            personalReads++;
            return { tracks: [local], streamingTracks: [] };
        };
        api.discoverSearch = async () => ({ results: [], aliasInfo: null });
        api.searchMusicSourceCatalog = async () => ({
            tracks: [],
            unavailable: [],
        });
        function Probe() {
            value = useSearchData({
                query: "saved",
                libraryType: "all",
                discoverType: "music",
                discoverScope: "all",
            });
            return null;
        }
        renderToStaticMarkup(
            React.createElement(
                QueryClientProvider,
                { client },
                React.createElement(Probe),
            ),
        );
        assert.ok(value.catalogNotice?.includes("любимом"));
        assert.deepEqual(value.libraryResults?.tracks, [local]);
        await value.retryCatalogSearch();
        assert.equal(personalReads, 1);
        assert.deepEqual(
            client.getQueryData(queryKeys.search("saved", "all", 20, "all")),
            { tracks: [local], streamingTracks: [] },
        );
    } finally {
        api.search = original.search;
        api.discoverSearch = original.discover;
        api.searchMusicSourceCatalog = original.native;
        client.clear();
    }
});
