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
        FeaturedShelvesSection: ({
            homeShelves,
        }: {
            homeShelves: Array<{ title?: string }>;
        }) =>
            React.createElement(
                "div",
                null,
                `provider-shelves:${homeShelves.map((shelf) => shelf.title).join("|")}`,
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
    moodCategories: [
        { title: "Mood", items: [{ title: "Focus", params: "focus" }] },
    ],
    genreCategories: [
        { title: "Genre", items: [{ title: "Rock", params: "rock" }] },
    ],
    isMoodsLoading: false,
    homeShelves: [
        {
            title: "Made for you",
            contents: [
                {
                    title: "Personal playlist",
                    playlistId: "personal",
                },
            ],
        },
        {
            title: "Schlager essentials",
            contents: [{ title: "Regional playlist", playlistId: "regional" }],
        },
        {
            title: "New releases",
            contents: [
                { title: "Fresh album", browseId: "album", type: "album" },
            ],
        },
        {
            title: "Popular right now",
            contents: [{ title: "Popular playlist", playlistId: "popular" }],
        },
        {
            title: "A fourth generic shelf",
            contents: [{ title: "Generic playlist", playlistId: "generic" }],
        },
    ],
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

    assert.match(html, /Explore something new/);
    assert.match(html, /provider-mixes:1/);
    assert.match(html, /provider-categories:1:1/);
    assert.match(
        html,
        /provider-shelves:Made for you\|New releases\|Popular right now/,
    );
    assert.doesNotMatch(html, /Schlager|A fourth generic shelf/);
    assert.match(html, /provider-charts:1/);
    assert.match(html, /YouTube Music/);
});

test("Home shelf curation removes duplicate and non-navigable provider rows", async () => {
    const { curateHomeShelves } =
        await import("../../features/home/components/HomeOnlineDiscovery");

    const curated = curateHomeShelves([
        {
            title: "For you",
            contents: [
                { title: "One", playlistId: "one" },
                { title: "One again", playlistId: "one" },
                { title: "No route", type: "artist" },
            ],
        },
        {
            title: "for YOU",
            contents: [{ title: "Duplicate shelf", playlistId: "two" }],
        },
    ]);

    assert.equal(curated.length, 1);
    assert.deepEqual(
        curated[0].contents?.map((item) => item.playlistId),
        ["one"],
    );
});

test("Home shelf curation recognizes Russian personal and discovery shelves", async () => {
    const { curateHomeShelves } =
        await import("../../features/home/components/HomeOnlineDiscovery");

    const curated = curateHomeShelves([
        {
            title: "Подборки редакции",
            contents: [{ title: "Generic", playlistId: "generic" }],
        },
        {
            title: "Новинки недели",
            contents: [{ title: "Fresh", playlistId: "fresh" }],
        },
        {
            title: "Для вас",
            contents: [{ title: "Personal", playlistId: "personal" }],
        },
        {
            title: "Немецкая музыка",
            contents: [{ title: "Wrong region", playlistId: "regional" }],
        },
    ]);

    assert.deepEqual(
        curated.map((shelf) => shelf.title),
        ["Для вас", "Новинки недели", "Подборки редакции"],
    );
});

test("Home online discovery does not invent content when provider browsing is off", async () => {
    const { HomeOnlineDiscovery } =
        await import("../../features/home/components/HomeOnlineDiscovery");
    const html = renderToStaticMarkup(
        React.createElement(HomeOnlineDiscovery, { ...props, enabled: false }),
    );

    assert.equal(html, "");
});
