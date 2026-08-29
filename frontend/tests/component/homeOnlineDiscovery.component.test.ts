import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/features/explore/components/YtMusicMixesSection", {
    namedExports: {
        YtMusicMixesSection: ({ mixes }: { mixes: unknown[] }) =>
            React.createElement("div", null, `provider-mixes:${mixes.length}`),
    },
});

mock.module("@/features/explore/components/MoodsGenresSection", {
    namedExports: {
        MoodsGenresSection: ({
            moodCategories,
            genreCategories,
        }: {
            moodCategories: unknown[];
            genreCategories: unknown[];
        }) =>
            React.createElement(
                "div",
                null,
                `provider-categories:${moodCategories.length}:${genreCategories.length}`,
            ),
    },
});

mock.module("@/features/explore/components/FeaturedShelvesSection", {
    namedExports: {
        FeaturedShelvesSection: ({ homeShelves }: { homeShelves: unknown[] }) =>
            React.createElement(
                "div",
                null,
                `provider-shelves:${homeShelves.length}`,
            ),
    },
});

mock.module("@/features/home/components/FeaturedPlaylistsGrid", {
    namedExports: {
        FeaturedPlaylistsGrid: ({ playlists }: { playlists: unknown[] }) =>
            React.createElement(
                "div",
                null,
                `provider-charts:${playlists.length}`,
            ),
    },
});

mock.module("@/features/home/components/SectionHeader", {
    namedExports: {
        SectionHeader: ({ title }: { title: string }) =>
            React.createElement("h2", null, title),
    },
});

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: {
        YouTubeBadge: () => React.createElement("span", null, "YouTube Music"),
    },
});

const props = {
    enabled: true,
    ytMusicMixes: [
        {
            playlistId: "mix",
            title: "Provider mix",
            description: "Personal provider mix",
            thumbnails: [],
            count: null,
        },
    ],
    moodCategories: [{ title: "Mood" }],
    genreCategories: [{ title: "Genre" }],
    isMoodsLoading: false,
    homeShelves: [{ title: "Shelf" }],
    chartPlaylists: [
        {
            id: "chart",
            source: "ytmusic" as const,
            type: "track" as const,
            title: "Chart track",
            description: "Artist",
            creator: "Artist",
            imageUrl: null,
            url: "https://music.youtube.com/watch?v=chart",
        },
    ],
};

test("Home online discovery renders live provider-backed sections", async () => {
    const { HomeOnlineDiscovery } =
        await import("../../features/home/components/HomeOnlineDiscovery");
    const html = renderToStaticMarkup(
        React.createElement(HomeOnlineDiscovery, props),
    );

    assert.match(html, /Explore music/);
    assert.match(html, /provider-mixes:1/);
    assert.match(html, /provider-categories:1:1/);
    assert.match(html, /provider-shelves:1/);
    assert.match(html, /provider-charts:1/);
    assert.match(html, /YouTube Music/);
});

test("Home online discovery does not invent content when provider browsing is off", async () => {
    const { HomeOnlineDiscovery } =
        await import("../../features/home/components/HomeOnlineDiscovery");
    const html = renderToStaticMarkup(
        React.createElement(HomeOnlineDiscovery, { ...props, enabled: false }),
    );

    assert.equal(html, "");
});
