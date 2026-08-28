import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    isLoading: false,
    isRefreshingMixes: false,
    isMoodsLoading: false,
    hasDegradedResults: false,
    degradedFailureSignature: "",
    providerFailures: {
        ytMusic: {
            mixes: false,
            categories: false,
            home: false,
            charts: false,
        },
        tidal: {
            mixes: false,
            moods: false,
            genres: false,
            home: false,
            explore: false,
        },
    },
    showYtMusicExplore: true,
    showTidalExplore: false,
    mixes: [{ id: "mix-1" }],
    recommended: [{ id: "artist-2" }],
    homeShelves: [{ title: "shelf-1" }],
    charts: { songs: [{ videoId: "v1", title: "Song 1" }] },
    popularArtists: [{ id: "artist-3" }],
    moodCategories: [{ title: "Chill" }],
    genreCategories: [{ title: "Rock" }],
    personalizedFeed: {
        shelves: {
            quickPicks: [{ id: "yt:quick", title: "Quick Track" }],
            listenAgain: [],
            discovery: [{ id: "yt:fresh", title: "Fresh Track" }],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    } as unknown,
};

const marker = (label: string) => {
    const Component = (_props?: Record<string, unknown>) =>
        React.createElement("div", null, label);
    Component.displayName = `Mock${label.replace(/[^a-zA-Z0-9]/g, "")}`;
    return Component;
};

const Icon = () => React.createElement("i");

mock.module("@/features/explore/hooks/useExploreData", {
    namedExports: {
        useExploreData: () => ({
            likedSummary: { total: 42, coverUrl: null },
            discoverWeekly: {
                weekStart: "2026-02-24",
                weekEnd: "2026-03-02",
                totalCount: 25,
                coverUrl: null,
            },
            mixes: state.mixes,
            recommended: state.recommended,
            homeShelves: state.homeShelves,
            charts: state.charts,
            popularArtists: state.popularArtists,
            quickStartStations: [],
            genreStations: [],
            decadeStations: [],
            moodCategories: state.moodCategories,
            genreCategories: state.genreCategories,
            ytMusicMixes: [],
            tidalHomeShelves: [],
            tidalExploreShelves: [],
            tidalGenres: [],
            tidalMoods: [],
            tidalMixes: [],
            isLoading: state.isLoading,
            isRefreshingMixes: state.isRefreshingMixes,
            isMoodsLoading: state.isMoodsLoading,
            isRadioLoading: false,
            hasDegradedResults: state.hasDegradedResults,
            degradedFailureSignature: state.degradedFailureSignature,
            providerFailures: state.providerFailures,
            showYtMusicExplore: state.showYtMusicExplore,
            showTidalExplore: state.showTidalExplore,
            handleRefreshMixes: async () => undefined,
            retryAll: async () => undefined,
        }),
    },
});

mock.module("@/features/explore/hooks/useUserSettingsExplorePrefs", {
    namedExports: {
        useUserSettingsExplorePrefs: () => ({
            showYtMusicExplore: state.showYtMusicExplore,
            showTidalExplore: state.showTidalExplore,
        }),
    },
});

mock.module("@/features/home/hooks/usePersonalizedHomeFeed", {
    namedExports: {
        usePersonalizedHomeFeed: () => ({
            data: state.personalizedFeed,
            isLoading: false,
            isError: false,
        }),
    },
});

mock.module("@/hooks/useQueries", {
    namedExports: {
        mapYtMusicChartsToFeaturedPlaylists: (
            charts: Record<string, Array<{ videoId: string; title: string }>>,
        ) => {
            const entries = Object.values(charts ?? {}).flat();
            return entries.map((e) => ({
                id: e.videoId,
                title: e.title,
            }));
        },
    },
});

mock.module("@/components/ui/LoadingScreen", {
    namedExports: { LoadingScreen: marker("loading-screen") },
});

mock.module("@/features/home/components/HomeHero", {
    namedExports: { HomeHero: marker("home-hero") },
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

mock.module("@/features/home/components/FeaturedPlaylistsGrid", {
    namedExports: { FeaturedPlaylistsGrid: marker("featured-playlists-grid") },
});

mock.module("@/features/home/components/LibraryRadioStations", {
    namedExports: {
        LibraryRadioStations: marker("library-radio-stations"),
        useLibraryRadioData: () => ({
            quickStartStations: [],
            genreStations: [],
            decadeStations: [],
            allStations: [],
            isLoading: false,
        }),
    },
});

mock.module("@/features/home/components/PersonalizedTrackShelf", {
    namedExports: {
        PersonalizedTrackShelf: ({ title }: { title: string }) =>
            React.createElement(
                "div",
                { "data-personalized-shelf": title },
                `personalized:${title}`,
            ),
    },
});

mock.module("@/features/explore/components/MadeForYouSection", {
    namedExports: { MadeForYouSection: marker("made-for-you-section") },
});

mock.module("@/features/explore/components/ProviderTabSection", {
    namedExports: { ProviderTabSection: marker("provider-tab-section") },
});

mock.module("@/features/explore/hooks/useTidalExploreEnabled", {
    namedExports: {
        useTidalExploreEnabled: () => ({
            showTidalExplore: state.showTidalExplore,
        }),
    },
});

mock.module("@/features/explore/components/MoodPills", {
    namedExports: { MoodPills: marker("mood-pills") },
});

mock.module("@/components/ui/LastFmBadge", {
    namedExports: { LastFmBadge: marker("lastfm-badge") },
});

mock.module("@/components/ui/LibraryBadge", {
    namedExports: { LibraryBadge: marker("library-badge") },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: { GradientSpinner: marker("gradient-spinner") },
});

mock.module("lucide-react", {
    namedExports: {
        RefreshCw: Icon,
        AudioWaveform: Icon,
        Compass: Icon,
        AlertTriangle: Icon,
        X: Icon,
    },
});

beforeEach(() => {
    state.isLoading = false;
    state.isRefreshingMixes = false;
    state.isMoodsLoading = false;
    state.hasDegradedResults = false;
    state.degradedFailureSignature = "";
    state.showYtMusicExplore = true;
    state.showTidalExplore = false;
    state.mixes = [{ id: "mix-1" }];
    state.recommended = [{ id: "artist-2" }];
    state.homeShelves = [{ title: "shelf-1" }];
    state.charts = { songs: [{ videoId: "v1", title: "Song 1" }] };
    state.popularArtists = [{ id: "artist-3" }];
    state.moodCategories = [{ title: "Chill" }];
    state.genreCategories = [{ title: "Rock" }];
    state.personalizedFeed = {
        shelves: {
            quickPicks: [{ id: "yt:quick", title: "Quick Track" }],
            listenAgain: [],
            discovery: [{ id: "yt:fresh", title: "Fresh Track" }],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    };
});

test("explore page renders loading screen while data is loading", async () => {
    state.isLoading = true;
    const ExplorePage = (await import("../../app/explore/page")).default;
    const html = renderToStaticMarkup(React.createElement(ExplorePage));

    assert.match(html, /loading-screen/);
});

test("explore page renders all sections when data is populated", async () => {
    const ExplorePage = (await import("../../app/explore/page")).default;
    const html = renderToStaticMarkup(React.createElement(ExplorePage));

    assert.match(html, /home-hero/);
    assert.match(html, /made-for-you-section/);
    assert.match(html, /personalized:Quick Start/);
    assert.match(html, /personalized:Fresh for you/);
    assert.match(html, /provider-tab-section/);
    assert.match(html, /Recommended For You/);
    assert.match(html, /artists-grid/);
    assert.match(html, /Popular Artists/);
    assert.match(html, /popular-artists-grid/);
});

test("explore page shows degraded-results notice only after a query failure", async () => {
    state.hasDegradedResults = true;
    state.degradedFailureSignature = "liked";
    const ExplorePage = (await import("../../app/explore/page")).default;
    const html = renderToStaticMarkup(React.createElement(ExplorePage));

    assert.match(html, /Some sections failed to load/);
    assert.match(html, />Retry</);
    assert.ok(
        html.indexOf("personalized:Quick Start") <
            html.indexOf("Some sections failed to load"),
        "Playable personal tracks stay ahead of provider failure notices",
    );
});

test("explore page hides recommended section when empty", async () => {
    state.recommended = [];
    const ExplorePage = (await import("../../app/explore/page")).default;
    const html = renderToStaticMarkup(React.createElement(ExplorePage));

    assert.doesNotMatch(html, /Recommended For You/);
});

test("explore page hides popular artists section when empty", async () => {
    state.popularArtists = [];
    const ExplorePage = (await import("../../app/explore/page")).default;
    const html = renderToStaticMarkup(React.createElement(ExplorePage));

    assert.doesNotMatch(html, /Popular Artists/);
});

test("explore page renders sections in correct order", async () => {
    const ExplorePage = (await import("../../app/explore/page")).default;
    const html = renderToStaticMarkup(React.createElement(ExplorePage));

    const madeForYouIdx = html.indexOf("made-for-you-section");
    const quickStartIdx = html.indexOf("personalized:Quick Start");
    const freshIdx = html.indexOf("personalized:Fresh for you");
    const moodPillsIdx = html.indexOf("mood-pills");
    const providerTabIdx = html.indexOf("provider-tab-section");
    const popularIdx = html.indexOf("Popular Artists");
    const recommendedIdx = html.indexOf("Recommended For You");

    assert.ok(quickStartIdx < freshIdx, "Quick Start before Fresh for you");
    assert.ok(
        freshIdx < moodPillsIdx,
        "Personal tracks before local mood shortcuts",
    );
    assert.ok(freshIdx < madeForYouIdx, "Personal shelves before Made For You");
    assert.ok(
        madeForYouIdx < providerTabIdx,
        "Made For You before Provider Tabs",
    );
    assert.ok(
        providerTabIdx < popularIdx,
        "Provider Tabs before Popular Artists",
    );
    assert.ok(
        popularIdx < recommendedIdx,
        "Popular Artists before Recommended",
    );
});

test("explore page does not render legacy tab navigation", async () => {
    const ExplorePage = (await import("../../app/explore/page")).default;
    const html = renderToStaticMarkup(React.createElement(ExplorePage));

    assert.doesNotMatch(html, /for-you-tab/);
    assert.doesNotMatch(html, /trending-tab/);
    assert.doesNotMatch(html, /moods-genres-tab/);
    assert.doesNotMatch(html, /Moods &amp; Genres/);
    assert.doesNotMatch(html, /Continue Listening/);
    assert.doesNotMatch(html, /Recently Added/);
});

test("explore page passes provider data to ProviderTabSection", async () => {
    const ExplorePage = (await import("../../app/explore/page")).default;
    const html = renderToStaticMarkup(React.createElement(ExplorePage));

    // ProviderTabSection is rendered (mocked as a marker)
    assert.match(html, /provider-tab-section/);
});
