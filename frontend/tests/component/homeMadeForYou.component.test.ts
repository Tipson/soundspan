import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
    PersonalizedHomeFeed,
    PersonalizedTrack,
} from "../../features/home/types";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

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
        ["Микс дня", "Новые находки", "Снова в ротации"],
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

test("Home Made For You renders at most five distinct real collections", async () => {
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

    assert.match(html, /Миксы для вас/);
    assert.match(html, /data-home-rail="mixes"/);
    assert.match(html, /data-home-mixes-surface="unified"/);
    assert.equal((html.match(/data-home-made-card=/g) ?? []).length, 5);
    assert.match(html, /Микс дня/);
    assert.match(html, /Новые находки/);
    assert.match(html, /Снова в ротации/);
    assert.match(html, /Открытия недели/);
    assert.match(html, /Mix 0/);
    assert.doesNotMatch(html, /Mix 1/);
    assert.match(html, /aria-controls="home-all-mixes"/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /href="\/playlists"/);
});

test("Home Made For You expands and collapses every collection inline on one surface", async () => {
    const { HomeMadeForYou } =
        await import("../../features/home/components/HomeMadeForYou");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
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
    });

    const surface = container.querySelector<HTMLElement>(
        '[data-home-mixes-surface="unified"]',
    );
    assert.ok(surface);
    assert.ok(surface.classList.contains("bg-surface"));
    assert.equal(surface.querySelectorAll("[data-home-made-card]").length, 5);
    assert.equal(surface.querySelector('a[href="/playlists"]'), null);

    const toggle = surface.querySelector<HTMLButtonElement>(
        'button[aria-controls="home-all-mixes"]',
    );
    assert.ok(toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.textContent?.trim(), "Показать все");

    await React.act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.textContent?.trim(), "Свернуть");
    assert.equal(surface.querySelectorAll("[data-home-made-card]").length, 12);
    assert.match(surface.textContent ?? "", /Mix 7/);
    assert.equal(surface.querySelector('a[href="/playlists"]'), null);

    await React.act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.textContent?.trim(), "Показать все");
    assert.equal(surface.querySelectorAll("[data-home-made-card]").length, 5);
    assert.doesNotMatch(surface.textContent ?? "", /Mix 1/);

    await React.act(async () => root.unmount());
    container.remove();
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
