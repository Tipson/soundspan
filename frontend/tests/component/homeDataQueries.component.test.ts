import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { queryKeys } from "../../lib/queryKeys";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

const forbiddenCalls = {
    recentlyListened: 0,
    recentlyAdded: 0,
    podcasts: 0,
    audiobooks: 0,
    recommendations: 0,
    popularArtists: 0,
};
const featureState = { discovery: true, autoPlaylists: true };
const personalizedFeedCalls: unknown[][] = [];
let dailyMixRequests = 0;

const queryResult = <T>(data: T) => ({
    data,
    isLoading: false,
    isError: false,
});

mock.module("@/lib/auth-context", {
    namedExports: { useAuth: () => ({ isAuthenticated: true }) },
});

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => featureState,
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({ waveMode: "new", waveMood: "focus" }),
    },
});

mock.module("@/features/explore/hooks/useUserSettingsExplorePrefs", {
    namedExports: {
        useUserSettingsExplorePrefs: () => ({
            showYtMusicExplore: true,
        }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (value: string) => value,
            getBrowseImageUrl: (value: string) => value,
            request: async () => ({
                mixes: [{ key: `generation-${++dailyMixRequests}` }],
            }),
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
        },
    },
});

mock.module("sonner", {
    namedExports: {
        toast: { success: () => undefined, error: () => undefined },
    },
});

mock.module("@/lib/query-events", {
    namedExports: {
        subscribeQueryEvent: () => () => undefined,
    },
});

mock.module("@/features/home/hooks/usePersonalizedHomeFeed", {
    namedExports: {
        usePersonalizedHomeFeed: (...args: unknown[]) => {
            personalizedFeedCalls.push(args);
            return {
                data: {
                    shelves: {
                        quickPicks: [{ id: "quick" }],
                        listenAgain: [],
                        discovery: [],
                    },
                    degraded: false,
                    reason: null,
                    seedCount: 1,
                },
                isLoading: false,
                isError: false,
            };
        },
    },
});

mock.module("@/hooks/useQueries", {
    namedExports: {
        useRecentlyListenedQuery: () => {
            forbiddenCalls.recentlyListened += 1;
            return queryResult({ items: [] });
        },
        useRecentlyAddedQuery: () => {
            forbiddenCalls.recentlyAdded += 1;
            return queryResult({ artists: [] });
        },
        useTopPodcastsQuery: () => {
            forbiddenCalls.podcasts += 1;
            return queryResult([]);
        },
        useAudiobooksQuery: () => {
            forbiddenCalls.audiobooks += 1;
            return queryResult([]);
        },
        useRecommendationsQuery: () => {
            forbiddenCalls.recommendations += 1;
            return queryResult({ artists: [] });
        },
        useLikedPlaylistQuery: () => queryResult({ total: 1, tracks: [] }),
        useDiscoverWeeklySummaryQuery: () => queryResult(null),
        useMixesQuery: () => queryResult([]),
        usePopularArtistsQuery: () => {
            forbiddenCalls.popularArtists += 1;
            return queryResult({ artists: [] });
        },
        useYtMusicHomeShelvesQuery: () => queryResult([]),
        useYtMusicChartsQuery: () => queryResult({}),
        useYtMusicCategoriesQuery: () =>
            queryResult({ moodCategories: [], genreCategories: [] }),
        useYtMusicMixesQuery: () => queryResult([]),
        mapYtMusicChartsToFeaturedPlaylists: () => [],
        useRefreshMixesMutation: () => ({
            mutateAsync: async () => undefined,
            isPending: false,
        }),
        queryKeys,
    },
});

beforeEach(() => {
    forbiddenCalls.recentlyListened = 0;
    forbiddenCalls.recentlyAdded = 0;
    forbiddenCalls.podcasts = 0;
    forbiddenCalls.audiobooks = 0;
    forbiddenCalls.recommendations = 0;
    forbiddenCalls.popularArtists = 0;
    featureState.discovery = true;
    featureState.autoPlaylists = true;
    personalizedFeedCalls.length = 0;
    dailyMixRequests = 0;
});

test("Home replaces a still-fresh daily mix cache at the UTC-day boundary and after a day-long background stay", async (t) => {
    t.mock.timers.enable({
        apis: ["Date"],
        now: new Date("2026-10-09T23:55:00Z").getTime(),
    });
    const { useHomeData } =
        await import("../../features/home/hooks/useHomeData");
    const { createRoot } = await import("react-dom/client");
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const Probe = () =>
        React.createElement(
            "output",
            null,
            useHomeData().dailyStyleMixes?.[0]?.key ?? "pending",
        );
    const settle = () =>
        React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
        });
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
        await settle();
        assert.equal(host.textContent, "generation-1");
        t.mock.timers.tick(10 * 60_000);
        await React.act(async () => window.dispatchEvent(new Event("focus")));
        await settle();
        assert.equal(
            host.textContent,
            "generation-2",
            "the one-hour cache must not carry yesterday's composition past midnight",
        );
        assert.equal(dailyMixRequests, 2);
        // Same local hour on the next day still needs a new daily composition.
        t.mock.timers.tick(24 * 60 * 60_000);
        await React.act(async () =>
            document.dispatchEvent(new Event("visibilitychange")),
        );
        await settle();
        assert.equal(host.textContent, "generation-3");
        assert.equal(dailyMixRequests, 3);
        assert.ok(
            personalizedFeedCalls.some((args) => args[7] === "2026-10-10"),
        );
        assert.ok(
            personalizedFeedCalls.some((args) => args[7] === "2026-10-11"),
        );
    } finally {
        await React.act(async () => root.unmount());
        client.clear();
        host.remove();
    }
});

test("Home does not mount generic Last.fm shelves on the personal landing", async () => {
    const { useHomeData } =
        await import("../../features/home/hooks/useHomeData");
    const Probe = () => {
        useHomeData();
        return null;
    };

    renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            React.createElement(Probe),
        ),
    );

    assert.equal(forbiddenCalls.recommendations, 0);
    assert.equal(forbiddenCalls.popularArtists, 0);
});

test("Home loads the personal online feed without legacy local-media queries", async () => {
    const { useHomeData } =
        await import("../../features/home/hooks/useHomeData");
    let result: ReturnType<typeof useHomeData> | null = null;
    const Probe = () => {
        result = useHomeData();
        return null;
    };

    renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            React.createElement(Probe),
        ),
    );

    assert.ok(result);
    assert.deepEqual(forbiddenCalls, {
        recentlyListened: 0,
        recentlyAdded: 0,
        podcasts: 0,
        audiobooks: 0,
        recommendations: 0,
        popularArtists: 0,
    });
    assert.equal("recentPodcasts" in result, false);
    assert.equal("recentAudiobooks" in result, false);
    assert.deepEqual(personalizedFeedCalls, [
        [12, true, "new", "focus"],
        [25, false, "for-you", null, "made-for-you", "any", null, null],
        [25, false, "for-you", null, "made-for-you", "any", null, null],
    ]);
});
