import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    QueryClient,
    QueryClientProvider,
    QueryObserver,
} from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys, useSearchQuery } from "../../hooks/useQueries";
import { useTrackPreference } from "../../hooks/useTrackPreference";
import { buildOptimisticTrackPreferenceResponse } from "../../hooks/trackPreferenceOptimistic";
import { ApiClientCore } from "../../lib/api/core";
import { getQueryClient } from "../../lib/query-client";
import { useSavedEntitySearch } from "../../features/search/hooks/useSavedEntitySearch";
import { useSavedMusicEntity } from "../../features/library/hooks/useSavedMusic";
import { parseSavedEntitySearchPage } from "../../features/search/savedEntitySearch";
import type { SavedMusicEntity } from "../../lib/api";

for (const existingData of [false, true]) {
    for (const failedMutation of [false, true]) {
        test(`${existingData ? "background" : "first"} private fill after ${failedMutation ? "uncertain failed" : "successful"} feedback cannot revive stale membership`, async () => {
            const client = new QueryClient({
                defaultOptions: { queries: { retry: false, gcTime: Infinity } },
            });
            const otherOwner = new QueryClient({
                defaultOptions: { queries: { retry: false, gcTime: Infinity } },
            });
            const id = "yt:abcdefghijk",
                query = "owner-private",
                key = queryKeys.search(query, "all", 20, "all");
            client.setQueryData(
                ["track-preference", id],
                buildOptimisticTrackPreferenceResponse(id, "thumbs_up"),
            );
            const rows = {
                artists: [],
                albums: [],
                tracks: [],
                streamingTracks: [{ id, title: "Private fixture" }],
            };
            otherOwner.setQueryData(key, rows);
            if (existingData) client.setQueryData(key, rows);
            const providerKey = queryKeys.discoverSearch(
                query,
                "music",
                20,
                "all",
            );
            const serviceKey = queryKeys.serviceCatalog(query);
            client.setQueryData(providerKey, {
                results: [{ id: "healthy-provider" }],
            });
            client.setQueryData(serviceKey, {
                tracks: [{ id: "healthy-native" }],
            });
            const oldSearch = api.search,
                oldSet = api.setTrackPreference;
            let release!: () => void,
                entered!: () => void,
                oldSignal: AbortSignal | undefined;
            const held = new Promise<void>((r) => (release = r)),
                waiting = new Promise<void>((r) => (entered = r));
            let changed = false,
                reads = 0;
            api.search = async (_q, _type, _limit, signal) => {
                reads++;
                const wasLiked = !changed;
                if (wasLiked) {
                    oldSignal = signal;
                    entered();
                    await held;
                }
                // Intentionally ignore abort, like a body already delivered by
                // a transport adapter. Query cancellation must reject the fill.
                return {
                    ...rows,
                    streamingTracks: wasLiked ? rows.streamingTracks : [],
                };
            };
            api.setTrackPreference = async () => {
                changed = true;
                if (failedMutation)
                    throw new Error("Fixture receipt lost after commit");
                return buildOptimisticTrackPreferenceResponse(id, "clear");
            };
            let preference!: ReturnType<typeof useTrackPreference>;
            function Probe() {
                useSearchQuery(query, "all", 20, "all");
                preference = useTrackPreference(id);
                return null;
            }
            let observer: QueryObserver | undefined,
                unsubscribe: (() => void) | undefined;
            try {
                renderToStaticMarkup(
                    React.createElement(
                        QueryClientProvider,
                        { client },
                        React.createElement(Probe),
                    ),
                );
                const cached = client
                    .getQueryCache()
                    .find({ queryKey: key, exact: true });
                assert.ok(cached);
                observer = new QueryObserver(client, {
                    ...cached.options,
                    queryKey: cached.queryKey,
                });
                unsubscribe = observer.subscribe(() => {});
                void observer.refetch({ cancelRefetch: false });
                await waiting;
                if (existingData)
                    client.setQueryData(key, { ...rows, streamingTracks: [] });
                if (failedMutation)
                    await assert.rejects(preference.setSignal("clear"));
                else await preference.setSignal("clear");
                release();
                await new Promise((r) => setTimeout(r, 40));
                const final = client.getQueryData<typeof rows>(key);
                assert.equal(
                    final?.streamingTracks.length,
                    0,
                    "Old fill overwrote invalidation with stale membership",
                );
                assert.equal(oldSignal?.aborted, true);
                assert.equal(
                    reads,
                    2,
                    "Cancellation must start one replacement private read",
                );
                assert.equal(
                    client.getQueryData<
                        ReturnType<
                            typeof buildOptimisticTrackPreferenceResponse
                        >
                    >(["track-preference", id])?.signal,
                    failedMutation ? "thumbs_up" : "clear",
                    "Ordered preference settlement/rollback remains separate",
                );
                assert.deepEqual(otherOwner.getQueryData(key), rows);
                assert.deepEqual(client.getQueryData(providerKey), {
                    results: [{ id: "healthy-provider" }],
                });
                assert.deepEqual(client.getQueryData(serviceKey), {
                    tracks: [{ id: "healthy-native" }],
                });
                assert.equal(
                    client.getQueryState(providerKey)?.isInvalidated,
                    false,
                );
                assert.equal(
                    client.getQueryState(serviceKey)?.isInvalidated,
                    false,
                );
            } finally {
                release();
                unsubscribe?.();
                observer?.destroy();
                await client.cancelQueries();
                client.clear();
                otherOwner.clear();
                api.search = oldSearch;
                api.setTrackPreference = oldSet;
            }
        });
    }
}

test("feedback invalidation cannot replay a search during its automatic Retry-After delay", async () => {
    const client = getQueryClient();
    const times: number[] = [];
    let changed = false;
    const server = createServer((_request, response) => {
        times.push(performance.now());
        response.writeHead(changed ? 200 : 429, {
            "Content-Type": "application/json",
            "Retry-After": "2",
        });
        response.end(
            JSON.stringify(
                changed
                    ? {
                          artists: [],
                          albums: [],
                          tracks: [],
                          streamingTracks: [],
                      }
                    : { error: "Fixture search rate limit" },
            ),
        );
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    class Wire extends ApiClientCore {}
    const wire = new Wire(`http://127.0.0.1:${address.port}`);
    const id = "yt:abcdefghijk",
        query = "held-rate",
        key = queryKeys.search(query, "all", 20, "all");
    client.setQueryData(
        ["track-preference", id],
        buildOptimisticTrackPreferenceResponse(id, "thumbs_up"),
    );
    const oldSearch = api.search,
        oldSet = api.setTrackPreference;
    api.search = (_q, _type, _limit, signal) =>
        wire.request("/search", { signal, retryOnTimeout: false });
    api.setTrackPreference = async () => {
        changed = true;
        return buildOptimisticTrackPreferenceResponse(id, "clear");
    };
    let preference!: ReturnType<typeof useTrackPreference>;
    function Probe() {
        useSearchQuery(query, "all", 20, "all");
        preference = useTrackPreference(id);
        return null;
    }
    let failed!: () => void;
    const rateObserved = new Promise<void>((r) => (failed = r));
    const stop = client.getQueryCache().subscribe((event) => {
        const reason = event.query.state.fetchFailureReason as {
            status?: number;
        } | null;
        if (event.query.queryKey[2] === query && reason?.status === 429)
            failed();
    });
    let observer: QueryObserver | undefined,
        unsubscribe: (() => void) | undefined;
    try {
        renderToStaticMarkup(
            React.createElement(
                QueryClientProvider,
                { client },
                React.createElement(Probe),
            ),
        );
        const cached = client
            .getQueryCache()
            .find({ queryKey: key, exact: true });
        assert.ok(cached);
        observer = new QueryObserver(client, {
            ...cached.options,
            queryKey: cached.queryKey,
        });
        unsubscribe = observer.subscribe(() => {});
        await rateObserved;
        await preference.setSignal("clear");
        await new Promise((resolve) => setTimeout(resolve, 75));
        assert.equal(
            times.length,
            1,
            "Cancellation erased the known rate receipt and caused early HTTP",
        );
        await new Promise((resolve) => setTimeout(resolve, 2100));
        assert.equal(times.length, 2);
        assert.ok(times[1] - times[0] >= 1900);
        assert.deepEqual(
            client.getQueryData<{ streamingTracks: unknown[] }>(key)
                ?.streamingTracks,
            [],
        );
    } finally {
        stop();
        unsubscribe?.();
        observer?.destroy();
        await client.cancelQueries();
        client.clear();
        api.search = oldSearch;
        api.setTrackPreference = oldSet;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("unsave retires the first saved-entity fill before current membership is read", async () => {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const entity = {
        type: "album" as const,
        source: "ytmusic",
        entityId: "fixture-album",
        title: "Saved fixture",
        subtitle: null,
        imageUrl: null,
    };
    const item: SavedMusicEntity = {
        id: "fixture-row",
        entityType: "album",
        source: entity.source,
        entityId: entity.entityId,
        title: entity.title,
        subtitle: null,
        imageUrl: null,
    };
    const query = "Saved",
        key = queryKeys.savedMusicSearch(query, "album");
    assert.equal(
        parseSavedEntitySearchPage(
            {
                items: [item],
                total: 1,
                search: { query, offset: 0, limit: 50 },
            },
            { query, type: "album", offset: 0, limit: 50 },
        ).items.length,
        1,
    );
    client.setQueryData(
        queryKeys.savedMusicStatus(entity.type, entity.source, entity.entityId),
        { saved: true, item },
    );
    let release!: () => void, entered!: () => void, invalidated!: () => void;
    const held = new Promise<void>((r) => (release = r)),
        waiting = new Promise<void>((r) => (entered = r)),
        invalidation = new Promise<void>((r) => (invalidated = r));
    const oldList = api.listSavedMusicEntities,
        oldRemove = api.removeSavedMusicEntity;
    let changed = false,
        reads = 0;
    api.listSavedMusicEntities = async () => {
        reads++;
        const wasSaved = !changed;
        if (wasSaved) {
            entered();
            await held;
        }
        return {
            items: wasSaved ? [item] : [],
            total: wasSaved ? 1 : 0,
            search: { query, offset: 0, limit: 50 },
        };
    };
    api.removeSavedMusicEntity = async () => {
        changed = true;
        return { saved: false, removed: true };
    };
    let action!: ReturnType<typeof useSavedMusicEntity>;
    function Probe() {
        useSavedEntitySearch(query, "album", true);
        action = useSavedMusicEntity(entity);
        return null;
    }
    let observer: QueryObserver | undefined,
        unsubscribe: (() => void) | undefined;
    const stop = client.getQueryCache().subscribe((event) => {
        if (
            event.query.queryKey[0] === "search" &&
            event.query.queryKey[1] === "saved-music" &&
            event.query.state.isInvalidated
        )
            invalidated();
    });
    try {
        renderToStaticMarkup(
            React.createElement(
                QueryClientProvider,
                { client },
                React.createElement(Probe),
            ),
        );
        const cached = client
            .getQueryCache()
            .find({ queryKey: key, exact: true });
        assert.ok(cached);
        observer = new QueryObserver(client, {
            ...cached.options,
            queryKey: cached.queryKey,
        });
        unsubscribe = observer.subscribe(() => {});
        await waiting;
        const mutation = action.toggle();
        await invalidation;
        release();
        await mutation;
        const visible =
            client
                .getQueryData<{ pages: { items: SavedMusicEntity[] }[] }>(key)
                ?.pages.flatMap((page) => page.items) ?? [];
        assert.equal(
            visible.length,
            0,
            "Old first saved fill overwrote the unsave invalidation",
        );
        assert.equal(reads, 2);
    } finally {
        release();
        stop();
        unsubscribe?.();
        observer?.destroy();
        await client.cancelQueries();
        client.clear();
        api.listSavedMusicEntities = oldList;
        api.removeSavedMusicEntity = oldRemove;
    }
});
