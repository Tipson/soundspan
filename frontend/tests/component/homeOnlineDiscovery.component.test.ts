import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = () => React.createElement("i");

mock.module("lucide-react", {
    namedExports: {
        ChevronRight: Icon,
        Dumbbell: Icon,
        Flame: Icon,
        Heart: Icon,
        History: Icon,
        Leaf: Icon,
        Music2: Icon,
        Sparkles: Icon,
        Zap: Icon,
    },
});

mock.module("@/components/ui/CachedImage", {
    namedExports: {
        CachedImage: ({ alt }: { alt: string }) =>
            React.createElement("img", { alt }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getBrowseImageUrl: (value: string) => value,
        },
    },
});

const props = {
    enabled: true,
    homeShelves: [
        {
            title: "Made for you",
            contents: [
                {
                    title: "Personal station",
                    playlistId: "personal",
                    thumbnailUrl: "/personal.jpg",
                },
            ],
        },
        {
            title: "Schlager essentials",
            contents: [{ title: "Wrong region", playlistId: "regional" }],
        },
        {
            title: "New releases",
            contents: [
                {
                    title: "Fresh album",
                    browseId: "album",
                    type: "album",
                    thumbnailUrl: "/album.jpg",
                },
                {
                    title: "Duplicate station",
                    playlistId: "personal",
                },
            ],
        },
    ],
    chartPlaylists: [
        {
            id: "chart",
            source: "ytmusic",
            type: "track",
            title: "Chart track",
            description: "Artist",
            creator: "Artist",
            imageUrl: "/chart.jpg",
            url: "https://music.youtube.com/watch?v=chart",
        },
    ],
};

test("Home discovery keeps provider rows without duplicating Vibe mood controls", async () => {
    const { HomeOnlineDiscovery } =
        await import("../../features/home/components/HomeOnlineDiscovery");
    const html = renderToStaticMarkup(
        React.createElement(HomeOnlineDiscovery, props),
    );

    assert.match(html, /Станции для вас/);
    assert.match(html, /data-home-rail="stations"/);
    assert.match(html, /data-home-card-shape="landscape"/);
    assert.doesNotMatch(html, /Your provider mix/);
    assert.match(html, /Personal station/);
    assert.match(html, /Новое и заметное/);
    assert.match(html, /data-home-rail="discoveries"/);
    assert.match(html, /data-home-card-shape="square"/);
    assert.match(html, /Fresh album/);
    assert.match(html, /Chart track/);
    assert.match(html, /href="\/explore\/yt-playlist\/chart"/);
    assert.doesNotMatch(html, /Pick a moment/);
    assert.doesNotMatch(html, /href="\/vibe\?mood=/);
    assert.doesNotMatch(html, /Schlager|Wrong region/);
    assert.equal((html.match(/Personal station/g) ?? []).length, 1);
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

test("Home shelf curation rejects a neutral shelf when its item titles or subtitles reveal a German regional dump", async () => {
    const { curateHomeShelves } =
        await import("../../features/home/components/HomeOnlineDiscovery");
    const regionalContent = [
        { title: "Germany essentials" },
        { title: "Deutschland heute" },
        { title: "Schlager favourites" },
        { title: "Megahits der 80er" },
        { title: "Singalong Hits Germany" },
        { title: "Neutral mix", subtitle: "Made in Deutschland" },
    ];

    for (const [index, regionalItem] of regionalContent.entries()) {
        const curated = curateHomeShelves([
            {
                title: "Для вас",
                contents: [
                    { title: "Любимые треки", playlistId: "ru-personal" },
                ],
            },
            {
                title: "Made for you",
                contents: [{ title: "Daily mix", playlistId: "en-personal" }],
            },
            {
                title: `Listen now ${index}`,
                contents: [
                    {
                        ...regionalItem,
                        playlistId: `regional-${index}`,
                    },
                ],
            },
        ]);

        assert.deepEqual(
            curated.map((shelf) => shelf.title),
            ["Для вас", "Made for you"],
            `regional item ${JSON.stringify(regionalItem)} must reject its whole shelf`,
        );
    }
});

test("Home discovery deduplicates chart playlists against provider shelves by playlist id", async () => {
    const { buildHomeDiscoveryRows } =
        await import("../../features/home/components/HomeOnlineDiscovery");

    const rows = buildHomeDiscoveryRows({
        homeShelves: [
            {
                title: "New releases",
                contents: [
                    {
                        title: "Provider playlist",
                        playlistId: "shared-playlist",
                    },
                ],
            },
        ],
        chartPlaylists: [
            {
                id: "shared-playlist",
                source: "ytmusic",
                type: "playlist",
                title: "Duplicate chart playlist",
                description: null,
                creator: "Provider",
                imageUrl: null,
                url: "https://music.youtube.com/playlist?list=shared-playlist",
            },
        ],
    });

    assert.deepEqual(
        rows.discoveries.map((item) => item.title),
        ["Provider playlist"],
    );
});

test("Home does not render a duplicate Vibe control when provider browsing is off", async () => {
    const { HomeOnlineDiscovery } =
        await import("../../features/home/components/HomeOnlineDiscovery");
    const html = renderToStaticMarkup(
        React.createElement(HomeOnlineDiscovery, { ...props, enabled: false }),
    );

    assert.doesNotMatch(
        html,
        /Pick a moment|href="\/vibe\?mood=|Stations for you|New &amp; noteworthy/,
    );
});
