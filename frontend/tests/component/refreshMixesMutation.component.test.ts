import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import {
    QueryClient,
    QueryClientProvider,
    useQuery,
    type QueryKey,
} from "@tanstack/react-query";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { queryKeys } from "../../lib/queryKeys";

GlobalRegistrator.register({ url: "https://soundspan.test/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
});
after(() => {
    GlobalRegistrator.unregister();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
let posts = 0;
mock.module("@/lib/api", {
    namedExports: {
        api: {
            refreshMixes: async () => {
                posts++;
                return { success: true };
            },
        },
    },
});

test("manual mix refresh waits for daily/daypart reads while leaving the playing Wave query alone", async () => {
    const { useRefreshMixesMutation } = await import("../../hooks/useQueries");
    const { createRoot } = await import("react-dom/client");
    const calls = { legacy: 0, daily: 0, daypart: 0, wave: 0 };
    const releases: Array<() => void> = [];
    function useObserved(name: keyof typeof calls, key: QueryKey) {
        return useQuery({
            queryKey: key,
            queryFn: () => {
                calls[name]++;
                return calls[name] === 1 || name === "wave"
                    ? Promise.resolve({ round: 1 })
                    : new Promise<{ round: number }>((resolve) =>
                          releases.push(() => resolve({ round: 2 })),
                      );
            },
        });
    }
    let launch: (() => Promise<unknown>) | undefined;
    function Probe() {
        useObserved("legacy", queryKeys.mixes());
        useObserved("daily", queryKeys.personalDailyMixes("2026-11-17"));
        useObserved("daypart", [
            ...queryKeys.personalizedHome(25, "for-you", null, "made-for-you"),
            "morning",
            "2026-11-17",
        ]);
        useObserved(
            "wave",
            queryKeys.personalizedHome(25, "for-you", null, "wave"),
        );
        const mutation = useRefreshMixesMutation();
        launch = () => mutation.mutateAsync();
        return React.createElement(
            "output",
            null,
            mutation.isPending ? "pending" : "ready",
        );
    }
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const flush = () =>
        React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
    let refreshing: Promise<unknown> | undefined;
    try {
        await React.act(async () =>
            root.render(
                React.createElement(
                    QueryClientProvider,
                    { client },
                    React.createElement(Probe),
                ),
            ),
        );
        await flush();
        assert.deepEqual(calls, { legacy: 1, daily: 1, daypart: 1, wave: 1 });
        assert.ok(launch);
        await React.act(async () => {
            refreshing = launch!();
        });
        await flush();
        assert.deepEqual(calls, { legacy: 2, daily: 2, daypart: 2, wave: 1 });
        assert.equal(posts, 1);
        assert.equal(host.textContent, "pending");
        await React.act(async () => {
            releases.forEach((release) => release());
            await refreshing;
        });
        await flush();
        assert.equal(host.textContent, "ready");
    } finally {
        releases.forEach((release) => release());
        await React.act(async () => root.unmount());
        client.clear();
        host.remove();
    }
});
