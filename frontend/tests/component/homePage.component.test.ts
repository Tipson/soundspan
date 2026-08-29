import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    isLoading: false,
    isRefreshingMixes: false,
    recommended: [{ id: "artist-2" }] as unknown[],
    mixes: [
        {
            id: "mix-1",
            name: "Daily Mix 1",
            description: "desc",
            coverUrls: [],
            trackCount: 10,
        },
    ] as unknown[],
    likedSummary: { total: 42, coverUrl: "/covers/liked.jpg" } as {
        total: number;
        coverUrl: string | null;
    } | null,
    discoverWeekly: {
        weekStart: "2026-02-24",
        weekEnd: "2026-03-02",
        totalCount: 25,
        coverUrl: "/covers/discover.jpg",
    } as {
        weekStart: string;
        weekEnd: string;
        totalCount: number;
        coverUrl: string | null;
    } | null,
    communityPlaylists: [
        {
            id: "pl-1",
            source: "ytmusic",
            type: "playlist",
            title: "Community Hits",
            description: "Popular",
            creator: "",
            imageUrl: null,
            url: "",
        },
    ] as unknown[],
    popularArtists: [{ id: "pop-1" }] as unknown[],
    isCommunityPlaylistsLoading: false,
    personalizedFeed: {
        shelves: {
            quickPicks: [{ id: "yt:quick-1", title: "Quick One" }],
            listenAgain: [{ id: "yt:again-1", title: "Again One" }],
            discovery: [{ id: "yt:new-1", title: "Fresh One" }],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    } as unknown,
    isPersonalizedLoading: false,
    isPersonalizedUnavailable: false,
};

const featuresState = {
    musicCNN: false,
    vibeEmbeddings: false,
    audioAnalysis: true,
    discovery: true,
    autoPlaylists: true,
    showVersion: false,
    loading: false,
};

const marker = (label: string) => {
    const Component = () => React.createElement("div", null, label);
    Component.displayName = `Mock${label.replace(/[^a-zA-Z0-9]/g, "")}`;
    return Component;
};

const Icon = () => React.createElement("i");

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => featuresState,
    },
});

mock.module("@/features/home/hooks/useHomeData", {
    namedExports: {
        useHomeData: () => ({
            recommended: state.recommended,
            mixes: state.mixes,
            likedSummary: state.likedSummary,
            discoverWeekly: state.discoverWeekly,
            communityPlaylists: state.communityPlaylists,
            popularArtists: state.popularArtists,
            isLoading: state.isLoading,
            isRefreshingMixes: state.isRefreshingMixes,
            isCommunityPlaylistsLoading: state.isCommunityPlaylistsLoading,
            personalizedFeed: state.personalizedFeed,
            isPersonalizedLoading: state.isPersonalizedLoading,
            isPersonalizedUnavailable: state.isPersonalizedUnavailable,
            handleRefreshMixes: async () => undefined,
        }),
    },
});

mock.module("@/components/ui/LoadingScreen", {
    namedExports: { LoadingScreen: marker("loading-screen") },
});

mock.module("@/features/home/components/HomeWaveHero", {
    namedExports: {
        HomeWaveHero: ({
            personalizedFeed,
        }: {
            personalizedFeed: {
                shelves: {
                    quickPicks: unknown[];
                    listenAgain: unknown[];
                    discovery: unknown[];
                };
            } | null;
        }) =>
            React.createElement(
                "div",
                null,
                `home-wave-hero:${
                    personalizedFeed
                        ? personalizedFeed.shelves.quickPicks.length +
                          personalizedFeed.shelves.listenAgain.length +
                          personalizedFeed.shelves.discovery.length
                        : 0
                }`,
            ),
    },
});

mock.module("@/features/home/components/HomeQuickActions", {
    namedExports: { HomeQuickActions: marker("home-quick-actions") },
});

mock.module("@/features/home/components/SectionHeader", {
    namedExports: {
        SectionHeader: ({ title }: { title: string }) =>
            React.createElement("h2", null, title),
    },
});

mock.module("@/features/home/components/ContinueListening", {
    namedExports: { ContinueListening: marker("continue-listening") },
});

mock.module("@/features/home/components/ArtistsGrid", {
    namedExports: { ArtistsGrid: marker("artists-grid") },
});

mock.module("@/features/home/components/PopularArtistsGrid", {
    namedExports: { PopularArtistsGrid: marker("popular-artists-grid") },
});

mock.module("@/features/home/components/PodcastsGrid", {
    namedExports: { PodcastsGrid: marker("podcasts-grid") },
});

mock.module("@/features/home/components/AudiobooksGrid", {
    namedExports: { AudiobooksGrid: marker("audiobooks-grid") },
});

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: {
        YouTubeBadge: () => React.createElement("span", null, "YT"),
    },
});

mock.module("@/components/ui/LastFmBadge", {
    namedExports: {
        LastFmBadge: () => React.createElement("span", null, "Last.fm"),
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: { GradientSpinner: marker("gradient-spinner") },
});

mock.module("@/features/social/components/PeerPlaylistsShelf", {
    namedExports: { PeerPlaylistsShelf: () => null },
});
mock.module("@/features/home/components/FeaturedPlaylistsGrid", {
    namedExports: { FeaturedPlaylistsGrid: marker("featured-playlists-grid") },
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
                "section",
                { "data-personalized-shelf": title },
                `${title}:${tracks.map((track) => track.title).join(",")}`,
            ),
    },
});

mock.module("@/features/home/components/StaticPlaylistCard", {
    namedExports: {
        StaticPlaylistCard: ({
            title,
            subtitle,
        }: {
            title: string;
            subtitle: string;
        }) => React.createElement("div", null, `${title} — ${subtitle}`),
    },
});

mock.module("@/components/ui/HorizontalCarousel", {
    namedExports: {
        HorizontalCarousel: ({ children }: { children: React.ReactNode }) =>
            React.createElement("div", { "data-testid": "carousel" }, children),
        CarouselItem: ({ children }: { children: React.ReactNode }) =>
            React.createElement(
                "div",
                { "data-testid": "carousel-item" },
                children,
            ),
    },
});

mock.module("@/components/MixCard", {
    namedExports: {
        MixCard: ({ mix }: { mix: { name: string } }) =>
            React.createElement("div", null, `mix-card:${mix.name}`),
    },
});

mock.module("lucide-react", {
    namedExports: { Heart: Icon, Compass: Icon, RefreshCw: Icon },
});

beforeEach(() => {
    featuresState.autoPlaylists = true;
    state.isLoading = false;
    state.isRefreshingMixes = false;
    state.recommended = [{ id: "artist-2" }];
    state.mixes = [
        {
            id: "mix-1",
            name: "Daily Mix 1",
            description: "desc",
            coverUrls: [],
            trackCount: 10,
        },
    ];
    state.likedSummary = { total: 42, coverUrl: "/covers/liked.jpg" };
    state.discoverWeekly = {
        weekStart: "2026-02-24",
        weekEnd: "2026-03-02",
        totalCount: 25,
        coverUrl: "/covers/discover.jpg",
    };
    state.communityPlaylists = [
        {
            id: "pl-1",
            source: "ytmusic",
            type: "playlist",
            title: "Community Hits",
            description: "Popular",
            creator: "",
            imageUrl: null,
            url: "",
        },
    ];
    state.popularArtists = [{ id: "pop-1" }];
    state.isCommunityPlaylistsLoading = false;
    state.personalizedFeed = {
        shelves: {
            quickPicks: [{ id: "yt:quick-1", title: "Quick One" }],
            listenAgain: [{ id: "yt:again-1", title: "Again One" }],
            discovery: [{ id: "yt:new-1", title: "Fresh One" }],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    };
    state.isPersonalizedLoading = false;
    state.isPersonalizedUnavailable = false;
});

test("home page renders loading screen while data is loading", async () => {
    state.isLoading = true;
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.match(html, /loading-screen/);
    assert.doesNotMatch(html, /Continue Listening/);
});

test("home page renders the Wave hero, quick access, and recommendation sections", async () => {
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.match(html, /home-wave-hero:3/);
    assert.match(html, /home-quick-actions/);
    assert.match(html, /Made For You/);
    assert.match(html, /Trending Community Playlists/);
    assert.match(html, /Recommended For You/);
});

test("home page leads with Wave and playable personal shelves", async () => {
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.match(html, /Quick picks:Quick One/);
    assert.match(html, /Listen again:Again One/);
    assert.match(html, /Fresh for you:Fresh One/);
    assert.ok(html.indexOf("home-wave-hero") < html.indexOf("Quick picks"));
    assert.ok(html.indexOf("Quick picks") < html.indexOf("Listen again"));
    assert.ok(html.indexOf("Listen again") < html.indexOf("Fresh for you"));
    assert.ok(html.indexOf("Fresh for you") < html.indexOf("Made For You"));
});

test("home page shows My Liked and Discover Weekly in Made For You", async () => {
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.match(html, /My Liked/);
    assert.match(html, /42 tracks/);
    assert.match(html, /Discover Weekly/);
    assert.match(html, /25 tracks/);
    assert.match(html, /mix-card:Daily Mix 1/);
});

test("home page does not render legacy local-library shelves", async () => {
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.doesNotMatch(html, /Continue Listening/);
    assert.doesNotMatch(html, /Recently Added/);
    assert.doesNotMatch(html, /Podcasts/);
    assert.doesNotMatch(html, /Audiobooks/);
});

test("home page hides Made For You when all sources empty", async () => {
    state.likedSummary = null;
    state.discoverWeekly = null;
    state.mixes = [];
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.doesNotMatch(html, /Made For You/);
});

test("home page hides Trending Community Playlists when empty", async () => {
    state.communityPlaylists = [];
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.doesNotMatch(html, /Trending Community Playlists/);
});

test("home page hides Recommended For You when empty", async () => {
    state.recommended = [];
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.doesNotMatch(html, /Recommended For You/);
});

test("home page hides the mixes Refresh button when autoPlaylists is disabled", async () => {
    featuresState.autoPlaylists = false;
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.match(html, /Made For You/);
    assert.doesNotMatch(html, /Refresh/);
});
