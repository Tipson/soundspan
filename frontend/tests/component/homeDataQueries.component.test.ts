import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const forbiddenCalls = {
    recentlyListened: 0,
    recentlyAdded: 0,
    podcasts: 0,
    audiobooks: 0,
};

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
        useFeatures: () => ({ discovery: true, autoPlaylists: true }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (value: string) => value,
            getBrowseImageUrl: (value: string) => value,
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
        usePersonalizedHomeFeed: () => ({
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
        }),
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
        useRecommendationsQuery: () => queryResult({ artists: [] }),
        useLikedPlaylistQuery: () => queryResult({ total: 1, tracks: [] }),
        useDiscoverWeeklySummaryQuery: () => queryResult(null),
        useMixesQuery: () => queryResult([]),
        usePopularArtistsQuery: () => queryResult({ artists: [] }),
        useYtMusicHomeShelvesQuery: () => queryResult([]),
        useRefreshMixesMutation: () => ({
            mutateAsync: async () => undefined,
            isPending: false,
        }),
        queryKeys: { mixes: () => ["mixes"] },
    },
});

beforeEach(() => {
    forbiddenCalls.recentlyListened = 0;
    forbiddenCalls.recentlyAdded = 0;
    forbiddenCalls.podcasts = 0;
    forbiddenCalls.audiobooks = 0;
});

test("Home loads music recommendations without legacy local-media queries", async () => {
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
    });
    assert.equal("recentPodcasts" in result, false);
    assert.equal("recentAudiobooks" in result, false);
});
