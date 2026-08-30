import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
    PersonalizedHomeFeed,
    PersonalizedTrack,
} from "../../features/home/types";

const Icon = () => React.createElement("i");

mock.module("lucide-react", {
    namedExports: { RefreshCw: Icon, Sparkles: Icon, Zap: Icon },
});

mock.module("@/lib/features-context", {
    namedExports: { useFeatures: () => ({ autoPlaylists: true }) },
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

mock.module("@/features/home/components/PersonalizedMixCard", {
    namedExports: {
        PersonalizedMixCard: ({
            title,
            tracks,
        }: {
            title: string;
            tracks: PersonalizedTrack[];
        }) =>
            React.createElement(
                "div",
                { "data-mix": title },
                `${title}:${tracks.map((track) => track.id).join(",")}`,
            ),
    },
});

mock.module("@/features/home/components/StaticPlaylistCard", {
    namedExports: {
        StaticPlaylistCard: ({ title }: { title: string }) =>
            React.createElement("div", null, title),
    },
});

mock.module("@/components/ui/CoverMosaic", {
    namedExports: {
        CoverMosaic: () => React.createElement("span", null, "covers"),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: { getCoverArtUrl: (value: string) => value },
    },
});

const track = (id: string): PersonalizedTrack => ({
    id,
    title: id,
    duration: 180,
    trackNo: null,
    artist: { id: null, name: `Artist ${id}` },
    album: { id: null, title: "Album", coverArt: `/${id}.jpg` },
    source: "youtube",
    provider: { tidalTrackId: null, youtubeVideoId: id },
    streamSource: "youtube",
    youtubeVideoId: id,
});

const feed: PersonalizedHomeFeed = {
    shelves: {
        quickPicks: [track("q1"), track("q2"), track("shared")],
        discovery: [track("d1"), track("d2"), track("shared")],
        listenAgain: [track("l1"), track("l2")],
    },
    degraded: false,
    reason: null,
    seedCount: 7,
};

test("personal Home mixes are distinct, playable, and bounded", async () => {
    const { buildHomePersonalMixes } =
        await import("../../features/home/components/HomeMadeForYou");

    const mixes = buildHomePersonalMixes(feed);

    assert.equal(mixes.length, 3);
    assert.deepEqual(
        mixes.map((mix) => mix.title),
        ["Daily blend", "Fresh finds", "Back in rotation"],
    );
    assert.ok(mixes.every((mix) => mix.tracks.length > 0));
    assert.ok(mixes.every((mix) => mix.tracks.length <= 12));
    assert.ok(
        mixes.every(
            (mix) =>
                new Set(mix.tracks.map((item) => item.youtubeVideoId)).size ===
                mix.tracks.length,
        ),
    );
    const identities = mixes.map((mix) =>
        mix.tracks
            .map((item) => item.youtubeVideoId)
            .sort()
            .join("|"),
    );
    assert.equal(new Set(identities).size, identities.length);
    const visibleTrackIds = mixes.flatMap((mix) =>
        mix.tracks.map((item) => item.youtubeVideoId),
    );
    assert.equal(new Set(visibleTrackIds).size, visibleTrackIds.length);
});

test("Home Made For You renders at most six real collections", async () => {
    const { HomeMadeForYou } =
        await import("../../features/home/components/HomeMadeForYou");
    const html = renderToStaticMarkup(
        React.createElement(HomeMadeForYou, {
            discoverWeekly: {
                weekStart: "2026-08-24",
                weekEnd: "2026-08-30",
                totalCount: 20,
                coverUrl: null,
            },
            mixes: Array.from({ length: 8 }, (_, index) => ({
                id: `mix-${index}`,
                name: `Mix ${index}`,
                description: "Generated from listening",
                coverUrls: [],
                trackCount: 20,
            })),
            personalizedFeed: feed,
            isRefreshingMixes: false,
            handleRefreshMixes: async () => undefined,
        }),
    );

    assert.match(html, /Made for you/);
    assert.equal((html.match(/data-home-made-card=/g) ?? []).length, 6);
    assert.match(html, /Daily blend/);
    assert.match(html, /Fresh finds/);
    assert.match(html, /Back in rotation/);
    assert.match(html, /Discover Weekly/);
    assert.match(html, /Mix 0/);
    assert.match(html, /Mix 1/);
    assert.doesNotMatch(html, /Mix 2/);
});

test("Home Made For You hides the whole shelf when nothing is playable", async () => {
    const { HomeMadeForYou } =
        await import("../../features/home/components/HomeMadeForYou");
    const html = renderToStaticMarkup(
        React.createElement(HomeMadeForYou, {
            discoverWeekly: null,
            mixes: [],
            personalizedFeed: null,
            isRefreshingMixes: false,
            handleRefreshMixes: async () => undefined,
        }),
    );

    assert.equal(html, "");
});
