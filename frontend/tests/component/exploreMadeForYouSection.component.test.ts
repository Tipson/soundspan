import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
    PersonalizedHomeFeed,
    PersonalizedTrack,
} from "../../features/home/types";

const featuresState = { autoPlaylists: true };
const Icon = () => React.createElement("i");

mock.module("@/lib/features-context", {
    namedExports: { useFeatures: () => featuresState },
});

mock.module("@/features/home/components/SectionHeader", {
    namedExports: {
        SectionHeader: ({
            title,
            rightAction,
        }: {
            title: string;
            rightAction?: React.ReactNode;
        }) => React.createElement("h2", null, title, rightAction),
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: () => React.createElement("span", null, "spinner"),
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
            React.createElement("div", null, children),
        CarouselItem: ({ children }: { children: React.ReactNode }) =>
            React.createElement("div", null, children),
    },
});

mock.module("@/components/MixCard", {
    namedExports: {
        MixCard: ({ mix }: { mix: { name: string } }) =>
            React.createElement("div", null, `mix:${mix.name}`),
    },
});

mock.module("@/features/home/components/PersonalizedMixCard", {
    namedExports: {
        PersonalizedMixCard: ({
            title,
            tracks,
        }: {
            title: string;
            tracks: unknown[];
        }) =>
            React.createElement(
                "div",
                null,
                `personal:${title}:${tracks.length}`,
            ),
    },
});

mock.module("lucide-react", {
    namedExports: { RefreshCw: Icon, Zap: Icon },
});

const discoverWeekly = {
    weekStart: "2026-08-24",
    weekEnd: "2026-08-30",
    totalCount: 25,
    coverUrl: null,
};
const mixes = [
    {
        id: "mix-1",
        name: "Daily Mix 1",
        description: "Real generated mix",
        coverUrls: [],
        trackCount: 10,
    },
];
const personalizedTrack = (id: string): PersonalizedTrack => ({
    id,
    title: id,
    duration: 180,
    trackNo: null,
    artist: { id: null, name: "Artist" },
    album: { id: null, title: "Album", coverArt: null },
    source: "youtube",
    provider: { tidalTrackId: null, youtubeVideoId: id },
    streamSource: "youtube",
    youtubeVideoId: id,
});
const personalizedFeed: PersonalizedHomeFeed = {
    shelves: {
        quickPicks: [personalizedTrack("quick")],
        discovery: [personalizedTrack("fresh")],
        listenAgain: [personalizedTrack("again")],
    },
    degraded: false,
    reason: null,
    seedCount: 3,
};

beforeEach(() => {
    featuresState.autoPlaylists = true;
});

async function renderMadeForYou(overrides?: {
    discoverWeekly?: typeof discoverWeekly | null;
    mixes?: typeof mixes;
    isRefreshingMixes?: boolean;
    personalizedFeed?: typeof personalizedFeed | null;
}) {
    const { MadeForYouSection } =
        await import("../../features/explore/components/MadeForYouSection");
    return renderToStaticMarkup(
        React.createElement(MadeForYouSection, {
            discoverWeekly:
                overrides?.discoverWeekly === undefined
                    ? discoverWeekly
                    : overrides.discoverWeekly,
            mixes: overrides?.mixes ?? mixes,
            personalizedFeed:
                overrides?.personalizedFeed === undefined
                    ? personalizedFeed
                    : overrides.personalizedFeed,
            isRefreshingMixes: overrides?.isRefreshingMixes ?? false,
            handleRefreshMixes: async () => undefined,
        }),
    );
}

test("Made For You contains only real generated recommendations", async () => {
    const html = await renderMadeForYou();

    assert.match(html, /Для вас/);
    assert.match(html, /Открытия недели/);
    assert.match(html, /25 треков/);
    assert.match(html, /mix:Daily Mix 1/);
    assert.match(html, /personal:Быстрый выбор:1/);
    assert.match(html, /personal:Новые находки:1/);
    assert.match(html, /personal:Послушать снова:1/);
    assert.doesNotMatch(html, /My Liked/);
});

test("Made For You filters empty generated entities", async () => {
    const html = await renderMadeForYou({
        discoverWeekly: { ...discoverWeekly, totalCount: 0 },
        mixes: [{ ...mixes[0], trackCount: 0 }],
        personalizedFeed: {
            ...personalizedFeed,
            shelves: {
                quickPicks: [],
                discovery: [],
                listenAgain: [],
            },
        },
    });

    assert.equal(html, "");
});

test("Made For You stays absent when automatic playlists are disabled", async () => {
    featuresState.autoPlaylists = false;
    const html = await renderMadeForYou({
        discoverWeekly: null,
        mixes: [],
        personalizedFeed: null,
    });

    assert.equal(html, "");
    assert.doesNotMatch(html, /Discover Weekly|Daily Mix|My Liked/);
});

test("account-backed Made For You shelves remain when generated playlists are disabled", async () => {
    featuresState.autoPlaylists = false;
    const html = await renderMadeForYou({
        discoverWeekly: null,
        mixes: [],
    });

    assert.match(html, /personal:Быстрый выбор:1/);
    assert.match(html, /personal:Новые находки:1/);
    assert.match(html, /personal:Послушать снова:1/);
    assert.doesNotMatch(html, /Обновить/);
});

test("Made For You exposes refresh only for enabled generated mixes", async () => {
    const html = await renderMadeForYou({ isRefreshingMixes: true });

    assert.match(html, /spinner/);
    assert.match(html, /Обновляем/);
    assert.match(html, /disabled/);

    featuresState.autoPlaylists = false;
    const disabledHtml = await renderMadeForYou({ mixes: [] });
    assert.doesNotMatch(disabledHtml, /Обновить/);
});
