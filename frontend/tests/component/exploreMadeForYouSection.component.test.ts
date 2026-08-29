import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

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

beforeEach(() => {
    featuresState.autoPlaylists = true;
});

async function renderMadeForYou(overrides?: {
    discoverWeekly?: typeof discoverWeekly | null;
    mixes?: typeof mixes;
    isRefreshingMixes?: boolean;
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
            isRefreshingMixes: overrides?.isRefreshingMixes ?? false,
            handleRefreshMixes: async () => undefined,
        }),
    );
}

test("Made For You contains only real generated recommendations", async () => {
    const html = await renderMadeForYou();

    assert.match(html, /Made For You/);
    assert.match(html, /Discover Weekly/);
    assert.match(html, /25 tracks/);
    assert.match(html, /mix:Daily Mix 1/);
    assert.doesNotMatch(html, /My Liked/);
});

test("Made For You filters empty generated entities", async () => {
    const html = await renderMadeForYou({
        discoverWeekly: { ...discoverWeekly, totalCount: 0 },
        mixes: [{ ...mixes[0], trackCount: 0 }],
    });

    assert.equal(html, "");
});

test("Made For You stays absent when automatic playlists are disabled", async () => {
    featuresState.autoPlaylists = false;
    const html = await renderMadeForYou({
        discoverWeekly: null,
        mixes: [],
    });

    assert.equal(html, "");
    assert.doesNotMatch(html, /Discover Weekly|Daily Mix|My Liked/);
});

test("Made For You exposes refresh only for enabled generated mixes", async () => {
    const html = await renderMadeForYou({ isRefreshingMixes: true });

    assert.match(html, /spinner/);
    assert.match(html, /Refreshing/);
    assert.match(html, /disabled/);

    featuresState.autoPlaylists = false;
    const disabledHtml = await renderMadeForYou({ mixes: [] });
    assert.doesNotMatch(disabledHtml, /Refresh/);
});
