import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys, useDiscoverSearchQuery } from "../../hooks/useQueries";
import { useSearchData } from "../../features/search/hooks/useSearchData";
import { api } from "../../lib/api";

test("partial discovery is stale immediately while complete discovery keeps its normal cache", () => {
    for (const partialFailure of [true, false]) {
        const client = new QueryClient();
        client.setQueryData(
            queryKeys.discoverSearch("Glass Animals", "music", 50, "all"),
            { results: [], partialFailure },
        );
        let stale: boolean | undefined;
        function Probe() {
            stale = useDiscoverSearchQuery(
                "Glass Animals",
                "music",
                50,
                "all",
            ).isStale;
            return null;
        }
        renderToStaticMarkup(
            React.createElement(
                QueryClientProvider,
                { client },
                React.createElement(Probe),
            ),
        );
        assert.equal(stale, partialFailure);
        client.clear();
    }
});

test("successful partial responses remain visible and retry refreshes their exact identities", async () => {
    const client = new QueryClient();
    client.setQueryData(
        queryKeys.discoverSearch("Glass Animals", "all", 20, "all"),
        { results: [], partialFailure: true },
    );
    let retry: (() => Promise<void>) | undefined;
    function Probe() {
        const data = useSearchData({ query: "Glass Animals", source: "local" });
        retry = data.retryCatalogSearch;
        return React.createElement("p", null, data.catalogNotice);
    }
    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(Probe),
        ),
    );
    assert.match(html, /Часть онлайн-каталога временно недоступна/);
    assert.equal(typeof retry, "function");
    const original = api.discoverSearch;
    let requests = 0;
    api.discoverSearch = async () => {
        requests++;
        return {
            results: [
                {
                    type: "track",
                    name: "Heat Waves",
                    youtubeVideoId: "mRD0-GxqHVo",
                },
            ],
            aliasInfo: null,
        };
    };
    try {
        await retry!();
        assert.equal(requests, 1);
        assert.deepEqual(
            client.getQueryData(
                queryKeys.discoverSearch("Glass Animals", "all", 20, "all"),
            ),
            {
                results: [
                    {
                        type: "track",
                        name: "Heat Waves",
                        youtubeVideoId: "mRD0-GxqHVo",
                    },
                ],
                aliasInfo: null,
            },
        );
    } finally {
        api.discoverSearch = original;
    }
    client.clear();
});

for (const failed of ["discovery", "service", "personal"] as const) {
    test(`catalog retry repeats only the failed ${failed} source`, async () => {
        const client = new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: Infinity } },
        });
        const query = "Проверка";
        const discoverKey = queryKeys.discoverSearch(query, "all", 20, "all");
        const serviceKey = queryKeys.serviceCatalog(query);
        const libraryKey = queryKeys.search(query, "all", 20, "all");
        const discovery = {
            results: [],
            partialFailure: failed === "discovery",
            aliasInfo: null,
        };
        const library = {
            tracks: [],
            streamingTracks: [],
            streamingUnavailable: failed === "personal",
        };
        client.setQueryData(discoverKey, discovery);
        client.setQueryData(serviceKey, {
            tracks: [],
            unavailable: failed === "service" ? ["vk"] : [],
        });
        client.setQueryData(libraryKey, library);
        let retry: (() => Promise<void>) | undefined;
        function Probe() {
            retry = useSearchData({ query }).retryCatalogSearch;
            return null;
        }
        renderToStaticMarkup(
            React.createElement(
                QueryClientProvider,
                { client },
                React.createElement(Probe),
            ),
        );
        const original = {
            discover: api.discoverSearch,
            service: api.searchMusicSourceCatalog,
            personal: api.search,
        };
        const calls: string[] = [];
        api.discoverSearch = async (text) => {
            assert.equal(text, query);
            calls.push("discovery");
            return { results: [], aliasInfo: null };
        };
        api.searchMusicSourceCatalog = async (text) => {
            assert.equal(text, query);
            calls.push("service");
            return { tracks: [], unavailable: [] };
        };
        api.search = async (text) => {
            assert.equal(text, query);
            calls.push("personal");
            return { tracks: [], streamingTracks: [] };
        };
        try {
            await retry!();
            assert.deepEqual(calls, [failed]);
            if (failed !== "discovery")
                assert.equal(client.getQueryData(discoverKey), discovery);
            if (failed !== "personal")
                assert.equal(client.getQueryData(libraryKey), library);
        } finally {
            api.discoverSearch = original.discover;
            api.searchMusicSourceCatalog = original.service;
            api.search = original.personal;
            client.clear();
        }
    });
}

for (const libraryType of ["all", "tracks"] as const) {
    test(`overlapping personal retries share one ${libraryType} request`, async () => {
        const client = new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: Infinity } },
        });
        const query = "Проверка";
        const library = {
            tracks: [],
            streamingTracks: [],
            streamingUnavailable: true,
        };
        client.setQueryData(queryKeys.search(query, "all", 20, "all"), library);
        client.setQueryData(queryKeys.searchTracks(query, "all"), {
            pages: [library],
            pageParams: [0],
        });
        client.setQueryData(queryKeys.discoverSearch(query, "all", 20, "all"), {
            results: [],
            aliasInfo: null,
        });
        client.setQueryData(queryKeys.serviceCatalog(query), {
            tracks: [],
            unavailable: [],
        });
        let retry!: () => Promise<void>;
        function Probe() {
            retry = useSearchData({ query, libraryType }).retryCatalogSearch;
            return null;
        }
        renderToStaticMarkup(
            React.createElement(
                QueryClientProvider,
                { client },
                React.createElement(Probe),
            ),
        );
        const original = {
            search: api.search,
            discover: api.discoverSearch,
            service: api.searchMusicSourceCatalog,
        };
        let finish!: () => void;
        const held = new Promise<void>((resolve) => {
            finish = resolve;
        });
        let reads = 0;
        api.search = async () => {
            reads++;
            await held;
            return { tracks: [], streamingTracks: [] };
        };
        api.discoverSearch = async () => ({ results: [], aliasInfo: null });
        api.searchMusicSourceCatalog = async () => ({
            tracks: [],
            unavailable: [],
        });
        const pending = [retry(), retry()];
        try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(reads, 1);
        } finally {
            finish();
            await Promise.allSettled(pending);
            api.search = original.search;
            api.discoverSearch = original.discover;
            api.searchMusicSourceCatalog = original.service;
            client.clear();
        }
    });
}

for (const libraryType of ["all", "tracks"] as const) {
    test(`a total owner search failure exposes retry and recovers the ${libraryType} read`, async () => {
        const client = new QueryClient({
            // Observe a settled failure; remount auto-retry would optimistically
            // turn an error without data into pending during the server render.
            defaultOptions: {
                queries: {
                    retry: false,
                    retryOnMount: false,
                    gcTime: Infinity,
                },
            },
        });
        const query = "Проверка";
        const privateKey =
            libraryType === "tracks"
                ? queryKeys.searchTracks(query, "all")
                : queryKeys.search(query, "all", 20, "all");
        await client
            .fetchQuery({
                queryKey: privateKey,
                queryFn: async () => {
                    throw new Error("Synthetic library outage");
                },
                retry: false,
            })
            .catch(() => {});
        const discovery = {
            results: [
                {
                    type: "track",
                    name: "Retained",
                    youtubeVideoId: "abcdefghijk",
                },
            ],
            aliasInfo: null,
        };
        const discoveryKey = queryKeys.discoverSearch(query, "all", 20, "all");
        client.setQueryData(discoveryKey, discovery);
        client.setQueryData(queryKeys.serviceCatalog(query), {
            tracks: [],
            unavailable: [],
        });
        let value!: ReturnType<typeof useSearchData>;
        function Probe() {
            value = useSearchData({ query, libraryType });
            return null;
        }
        const original = {
            search: api.search,
            discover: api.discoverSearch,
            service: api.searchMusicSourceCatalog,
        };
        const calls: string[] = [];
        api.search = async (text, type) => {
            assert.equal(text, query);
            assert.equal(type, libraryType);
            calls.push("private");
            return { tracks: [], streamingTracks: [] };
        };
        api.discoverSearch = async () => {
            calls.push("discovery");
            return { results: [], aliasInfo: null };
        };
        api.searchMusicSourceCatalog = async () => {
            calls.push("service");
            return { tracks: [], unavailable: [] };
        };
        try {
            const render = () =>
                renderToStaticMarkup(
                    React.createElement(
                        QueryClientProvider,
                        { client },
                        React.createElement(Probe),
                    ),
                );
            render();
            assert.ok(
                value.catalogNotice,
                "An unavailable private source must expose a retry instead of looking empty",
            );
            assert.equal(value.discoverResults.length, 1);
            await value.retryCatalogSearch();
            assert.deepEqual(calls, ["private"]);
            assert.equal(client.getQueryState(privateKey)?.status, "success");
            assert.equal(client.getQueryData(discoveryKey), discovery);
            render();
            assert.equal(value.catalogNotice, null);
            assert.equal(value.discoverResults.length, 1);
        } finally {
            api.search = original.search;
            api.discoverSearch = original.discover;
            api.searchMusicSourceCatalog = original.service;
            client.clear();
        }
    });
}
