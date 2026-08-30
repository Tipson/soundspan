import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    isLoading: false,
    recommended: [{ id: "artist-2" }] as unknown[],
    mixes: [{ id: "mix-1", name: "Daily Mix", trackCount: 10 }] as unknown[],
    discoverWeekly: {
        weekStart: "2026-08-24",
        weekEnd: "2026-08-30",
        totalCount: 25,
        coverUrl: null,
    } as unknown,
    popularArtists: [{ id: "popular-1" }] as unknown[],
    personalizedFeed: {
        shelves: {
            quickPicks: [{ id: "quick", title: "Quick One" }],
            listenAgain: [{ id: "again", title: "Again One" }],
            discovery: [{ id: "fresh", title: "Fresh One" }],
        },
        degraded: false,
        reason: null,
        seedCount: 3,
    } as unknown,
    isPersonalizedLoading: false,
    isPersonalizedUnavailable: false,
    showYtMusicExplore: true,
};

const marker = (label: string) => {
    const Component = () => React.createElement("div", null, label);
    Component.displayName = `Mock${label.replace(/[^a-zA-Z0-9]/g, "")}`;
    return Component;
};

mock.module("@/features/home/hooks/useHomeData", {
    namedExports: {
        useHomeData: () => ({
            ...state,
            isRefreshingMixes: false,
            homeShelves: [{ title: "From YouTube Music" }],
            chartPlaylists: [{ id: "chart-1" }],
            moodCategories: [{ title: "Moods" }],
            genreCategories: [{ title: "Genres" }],
            ytMusicMixes: [{ playlistId: "mix-provider-1" }],
            isMoodsLoading: false,
            handleRefreshMixes: async () => undefined,
        }),
    },
});

mock.module("@/components/ui/LoadingScreen", {
    namedExports: { LoadingScreen: marker("loading-screen") },
});

mock.module("@/features/home/components/HomeWaveHero", {
    namedExports: { HomeWaveHero: marker("compact-wave-hero") },
});

mock.module("@/features/home/components/HomeQuickActions", {
    namedExports: { HomeQuickActions: marker("home-quick-actions") },
});

mock.module("@/features/home/components/PersonalizedTrackShelf", {
    namedExports: {
        PersonalizedTrackShelf: ({
            title,
            tracks,
        }: {
            title: string;
            tracks: Array<{ title: string }>;
        }) =>
            React.createElement(
                "div",
                { "data-personalized-shelf": title },
                `${title}:${tracks.map((track) => track.title).join(",")}`,
            ),
    },
});

mock.module("@/features/home/components/HomeMadeForYou", {
    namedExports: {
        HomeMadeForYou: ({
            discoverWeekly,
            mixes,
            personalizedFeed,
        }: {
            discoverWeekly: unknown;
            mixes: unknown[];
            personalizedFeed: {
                shelves?: { discovery?: unknown[] };
            } | null;
        }) =>
            React.createElement(
                "div",
                null,
                `made-for-you:${discoverWeekly ? "weekly" : "none"}:${mixes.length}:${personalizedFeed?.shelves?.discovery?.length ?? 0}`,
            ),
    },
});

mock.module("@/features/home/components/HomeOnlineDiscovery", {
    namedExports: {
        HomeOnlineDiscovery: ({
            enabled,
            homeShelves,
        }: {
            enabled: boolean;
            homeShelves: unknown[];
        }) =>
            React.createElement(
                "div",
                null,
                `online-discovery:${enabled}:${homeShelves.length}`,
            ),
    },
});

mock.module("@/features/home/components/SectionHeader", {
    namedExports: {
        SectionHeader: ({ title }: { title: string }) =>
            React.createElement("h2", null, title),
    },
});

mock.module("@/features/home/components/ArtistsGrid", {
    namedExports: { ArtistsGrid: marker("artists-grid") },
});

mock.module("@/features/home/components/PopularArtistsGrid", {
    namedExports: { PopularArtistsGrid: marker("popular-artists-grid") },
});

mock.module("@/components/ui/LastFmBadge", {
    namedExports: { LastFmBadge: marker("lastfm") },
});

beforeEach(() => {
    state.isLoading = false;
    state.mixes = [{ id: "mix-1", name: "Daily Mix", trackCount: 10 }];
    state.discoverWeekly = {
        weekStart: "2026-08-24",
        weekEnd: "2026-08-30",
        totalCount: 25,
        coverUrl: null,
    };
    state.personalizedFeed = {
        shelves: {
            quickPicks: [{ id: "quick", title: "Quick One" }],
            listenAgain: [{ id: "again", title: "Again One" }],
            discovery: [{ id: "fresh", title: "Fresh One" }],
        },
        degraded: false,
        reason: null,
        seedCount: 3,
    };
    state.isPersonalizedLoading = false;
    state.isPersonalizedUnavailable = false;
    state.showYtMusicExplore = true;
});

test("Home shows a loading screen before the unified feed is ready", async () => {
    state.isLoading = true;
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.match(html, /loading-screen/);
});

test("Home unifies personal playback and real online discovery", async () => {
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.match(html, /compact-wave-hero/);
    assert.match(html, /Continue listening:Again One/);
    assert.doesNotMatch(html, /Picked for right now:Quick One/);
    assert.match(html, /made-for-you:weekly:1:1/);
    assert.match(html, /online-discovery:true:1/);
    assert.ok(
        html.indexOf("compact-wave-hero") < html.indexOf("home-quick-actions"),
    );
    assert.ok(
        html.indexOf("home-quick-actions") < html.indexOf("Continue listening"),
    );
    assert.ok(
        html.indexOf("Continue listening") < html.indexOf("made-for-you"),
    );
    assert.ok(html.indexOf("made-for-you") < html.indexOf("online-discovery"));
});

test("Home omits legacy local-library Explore surfaces", async () => {
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.doesNotMatch(html, /mood-pills|Library Radio|Recently Added/);
    assert.doesNotMatch(html, /Podcasts|Audiobooks|Listen Together/);
});

test("Home keeps real personal shelves when generated mixes are unavailable", async () => {
    state.mixes = [];
    state.discoverWeekly = null;
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.match(html, /Continue listening:Again One/);
    assert.doesNotMatch(html, /Picked for right now:Quick One/);
    assert.match(html, /made-for-you:none:0:1/);
    assert.doesNotMatch(html, /Daily Mix|Discover Weekly/);
});
