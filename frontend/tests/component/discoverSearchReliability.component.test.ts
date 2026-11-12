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
