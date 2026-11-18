import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    QueryClientProvider,
    QueryObserver,
    type QueryClient,
} from "@tanstack/react-query";
import { api } from "../../lib/api";
import { ApiClientCore } from "../../lib/api/core";
import { getQueryClient } from "../../lib/query-client";
import { queryKeys } from "../../lib/queryKeys";
import { useSearchQuery } from "../../hooks/useQueries";
import { useSearchData } from "../../features/search/hooks/useSearchData";
import { remainingSearchRetryMs } from "../../features/search/searchRetryPolicy";

const query = "Кино";
class WireClient extends ApiClientCore {}
type WireError = Error & { status?: number; retryAfterMs?: number };

async function interruptedRateResponse(
    status: number,
    mode: "truncate" | "hang",
    run: (wire: WireClient, count: () => number) => Promise<void>,
) {
    let count = 0;
    const server = createServer((_request, response) => {
        count++;
        response.writeHead(status, {
            "Content-Type": "application/json",
            "Retry-After": "2",
        });
        response.flushHeaders();
        response.write('{"error":');
        if (mode === "truncate") setTimeout(() => response.destroy(), 60);
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
        await run(
            new WireClient(`http://127.0.0.1:${address.port}`),
            () => count,
        );
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

for (const status of [429, 503]) {
    test(`received ${status} holdoff survives a truncated error body`, () =>
        interruptedRateResponse(status, "truncate", async (wire, count) => {
            await assert.rejects(
                wire.request("/search?q=truncated", {
                    retryOnTimeout: false,
                    timeoutMs: 1000,
                }),
                (error: unknown) => {
                    assert.ok(error instanceof Error);
                    assert.equal((error as WireError).status, status);
                    assert.equal((error as WireError).retryAfterMs, 2000);
                    assert.ok(remainingSearchRetryMs(error) > 1000);
                    return true;
                },
            );
            assert.equal(count(), 1);
        }));
}

test("a known rate response prevents the inner timeout replay", () =>
    interruptedRateResponse(429, "hang", async (wire, count) => {
        await assert.rejects(
            wire.request("/search?q=timeout", {
                timeoutMs: 60,
                retryOnTimeout: true,
            }),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(
                    count(),
                    1,
                    "Known rate headers prevent an inner timeout replay",
                );
                assert.equal((error as WireError).status, 429);
                assert.ok(remainingSearchRetryMs(error) > 1000);
                return true;
            },
        );
        assert.equal(count(), 1);
    }));

test("caller cancellation after rate headers keeps abort semantics", () =>
    interruptedRateResponse(429, "hang", async (wire, count) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60);
        try {
            await assert.rejects(
                wire.request("/search?q=cancel", {
                    signal: controller.signal,
                    timeoutMs: 1000,
                }),
                (error: unknown) => {
                    assert.ok(error instanceof Error);
                    assert.equal(error.name, "AbortError");
                    assert.equal((error as WireError).status, undefined);
                    return true;
                },
            );
            assert.equal(count(), 1);
        } finally {
            clearTimeout(timer);
        }
    }));

test("a receipt callback rejection is not reclassified as a rate body error", () =>
    interruptedRateResponse(429, "truncate", async (wire, count) => {
        const rejected = new Error("Receipt observer rejected the operation");
        await assert.rejects(
            wire.request("/search?q=observer", {
                retryOnTimeout: false,
                _onResponseReceipt: () => {
                    throw rejected;
                },
            }),
            (error: unknown) => error === rejected,
        );
        assert.equal(count(), 1);
    }));

test("a retired logical owner wins over received rate headers", () =>
    interruptedRateResponse(429, "truncate", async (wire, count) => {
        let retired = false;
        const rejected = new Error("Logical search owner was retired");
        await assert.rejects(
            wire.request("/search?q=retired", {
                retryOnTimeout: false,
                _onResponseReceipt: () => {
                    retired = true;
                },
                _assertSession: () => {
                    if (retired) throw rejected;
                },
            }),
            (error: unknown) => error === rejected,
        );
        assert.equal(count(), 1);
    }));
async function fixture(
    delay: number,
    run: (context: {
        client: QueryClient;
        times: number[];
        errors: WireError[];
    }) => Promise<void>,
) {
    const times: number[] = [],
        errors: WireError[] = [];
    const server = createServer((request, response) => {
        assert.equal(
            new URL(request.url!, "http://fixture").searchParams.get("q"),
            query,
        );
        times.push(performance.now());
        response.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": String(delay),
        });
        response.end(JSON.stringify({ error: "Search fixture rate limit" }));
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const wire = new WireClient(`http://127.0.0.1:${address.port}`);
    const client = getQueryClient(),
        original = api.search;
    api.search = async (q, type, limit, signal, source) => {
        try {
            return await wire.request<Awaited<ReturnType<typeof original>>>(
                `/search?${new URLSearchParams({ q, type: type ?? "all", limit: String(limit ?? 20), source: source ?? "all" })}`,
                { signal, retryOnTimeout: false },
            );
        } catch (error) {
            errors.push(error as WireError);
            throw error;
        }
    };
    try {
        await run({ client, times, errors });
    } finally {
        api.search = original;
        await client.cancelQueries();
        client.clear();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

test("search automatic retry honors actual HTTP429 Retry-After without changing global query policy", () =>
    fixture(2, async ({ client, times, errors }) => {
        let live!: ReturnType<typeof useSearchQuery>;
        function Probe() {
            live = useSearchQuery(query, "all", 20, "local");
            return null;
        }
        renderToStaticMarkup(
            React.createElement(
                QueryClientProvider,
                { client },
                React.createElement(Probe),
            ),
        );
        await live.refetch();
        assert.equal(errors.at(-1)?.status, 429);
        assert.equal(errors.at(-1)?.retryAfterMs, 2000);
        assert.equal(times.length, 2);
        assert.ok(
            times[1] - times[0] >= 1900,
            "Search HTTP was retried before Retry-After",
        );
        const defaultDelay = client.getDefaultOptions().queries?.retryDelay;
        assert.equal(typeof defaultDelay, "function");
        assert.equal(
            (defaultDelay as (attempt: number, error: Error) => number)(
                0,
                errors[0],
            ),
            1000,
        );
    }));

test("an automatic remount cannot bypass the current search holdoff", () =>
    fixture(2, async ({ client, times }) => {
        const defaults = client.getDefaultOptions();
        client.setDefaultOptions({
            ...defaults,
            queries: { ...defaults.queries, retry: false },
        });
        let live!: ReturnType<typeof useSearchQuery>;
        function Probe() {
            live = useSearchQuery(query, "all", 20, "local");
            return null;
        }
        renderToStaticMarkup(
            React.createElement(
                QueryClientProvider,
                { client },
                React.createElement(Probe),
            ),
        );
        await live.refetch();
        const cached = client.getQueryCache().find({
            queryKey: queryKeys.search(query, "all", 20, "local"),
            exact: true,
        });
        assert.ok(cached);
        const observer = new QueryObserver(client, {
            ...cached.options,
            queryKey: cached.queryKey,
        });
        const unsubscribe = observer.subscribe(() => {});
        try {
            await new Promise((resolve) => setTimeout(resolve, 75));
            assert.equal(times.length, 1);
            await new Promise((resolve) => setTimeout(resolve, 2100));
            await Promise.all([
                live.refetch({ cancelRefetch: false }),
                live.refetch({ cancelRefetch: false }),
            ]);
            assert.equal(
                times.length,
                2,
                "Expired holdoff permits one current-query read after remount",
            );
        } finally {
            unsubscribe();
            observer.destroy();
        }
    }));

for (const kind of ["all", "tracks"] as const) {
    test(`explicit ${kind} search retry and pagination retain server holdoff and in-flight dedup`, () =>
        fixture(2, async ({ client, times }) => {
            const defaults = client.getDefaultOptions();
            client.setDefaultOptions({
                ...defaults,
                queries: {
                    ...defaults.queries,
                    retry: false,
                    retryOnMount: false,
                },
            });
            const key =
                kind === "all"
                    ? queryKeys.search(query, "all", 20, "local")
                    : queryKeys.searchTracks(query, "local");
            const rows = Array.from({ length: 50 }, (_, index) => ({
                id: `retained-${index}`,
                title: "Retained",
            }));
            const page = {
                artists: [],
                albums: [],
                tracks: rows,
                audiobooks: [],
                podcasts: [],
                episodes: [],
            };
            client.setQueryData(
                key,
                kind === "all" ? page : { pages: [page], pageParams: [0] },
            );
            client.setQueryData(
                queryKeys.discoverSearch(query, "music", 20, "tracks"),
                { results: [], aliasInfo: null, partialFailure: false },
            );
            let live!: ReturnType<typeof useSearchData>;
            function Probe() {
                live = useSearchData({
                    query,
                    libraryType: kind,
                    source: "local",
                    discoverType: "music",
                    discoverScope: "tracks",
                });
                return null;
            }
            const render = () =>
                renderToStaticMarkup(
                    React.createElement(
                        QueryClientProvider,
                        { client },
                        React.createElement(Probe),
                    ),
                );
            render();
            await client.refetchQueries({ queryKey: key, exact: true });
            render();
            assert.equal(times.length, 1);
            assert.ok(live.catalogNotice);
            await Promise.all([
                live.retryCatalogSearch(),
                live.retryCatalogSearch(),
            ]);
            await live.retryCatalogSearch();
            if (kind === "tracks") await live.fetchNextLibraryTracks();
            assert.equal(
                times.length,
                1,
                "Manual retry/paging sent HTTP during the server holdoff",
            );
            assert.equal(live.libraryResults?.tracks?.length, 50);
            await new Promise((resolve) => setTimeout(resolve, 2100));
            await Promise.all([
                live.retryCatalogSearch(),
                live.retryCatalogSearch(),
            ]);
            assert.equal(
                times.length,
                2,
                "Eligible concurrent retries must share one HTTP request",
            );
            // Keep this pre-render action closure: the newly settled failure
            // must establish its own holdoff before React renders it again.
            await live.retryCatalogSearch();
            if (kind === "tracks") await live.fetchNextLibraryTracks();
            assert.equal(times.length, 2);
        }));
}
