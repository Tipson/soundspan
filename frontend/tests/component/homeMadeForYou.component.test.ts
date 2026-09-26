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

const richFeed: PersonalizedHomeFeed = {
    ...feed,
    shelves: {
        quickPicks: Array.from({ length: 25 }, (_, index) =>
            track(`q${index}`),
        ),
        discovery: Array.from({ length: 25 }, (_, index) => track(`d${index}`)),
        listenAgain: Array.from({ length: 25 }, (_, index) =>
            track(`l${index}`),
        ),
    },
};

const timeFeed: PersonalizedHomeFeed = {
    ...feed,
    shelves: {
        quickPicks: Array.from({ length: 25 }, (_, index) =>
            track(`tq${index}`),
        ),
        discovery: Array.from({ length: 25 }, (_, index) =>
            track(`td${index}`),
        ),
        listenAgain: [],
    },
};

test("time-of-day mix changes at local boundaries", async () => {
    const { timeOfDayMixForHour } =
        await import("../../features/home/components/HomeMadeForYou");

    assert.equal(timeOfDayMixForHour(4).key, "night");
    assert.equal(timeOfDayMixForHour(5).key, "night");
    assert.equal(timeOfDayMixForHour(6).key, "morning");
    assert.equal(timeOfDayMixForHour(11).title, "Ваше утро");
    assert.equal(timeOfDayMixForHour(12).key, "daytime");
    assert.equal(timeOfDayMixForHour(17).title, "Ваш день");
    assert.equal(timeOfDayMixForHour(18).key, "evening");
    assert.equal(timeOfDayMixForHour(23).title, "Ваш вечер");
    assert.equal(timeOfDayMixForHour(0).title, "Ваша ночь");
});

test("three daily mixes and current time mix offer long, differently led queues", async () => {
    const { buildHomePersonalMixes, timeOfDayMixForHour } =
        await import("../../features/home/components/HomeMadeForYou");

    const mixes = buildHomePersonalMixes(
        richFeed,
        timeFeed,
        timeOfDayMixForHour(8),
    );
    assert.deepEqual(
        mixes.map((mix) => mix.title),
        ["Микс дня 1", "Микс дня 2", "Микс дня 3", "Ваше утро"],
    );
    assert.ok(mixes.every((mix) => mix.tracks.length === 40));
    assert.deepEqual(
        mixes.map((mix) => mix.tracks[0].youtubeVideoId),
        ["q0", "d0", "l0", "td0"],
    );
    assert.ok(mixes[0].tracks.some((item) => item.youtubeVideoId === "q0"));
    assert.ok(mixes[2].tracks.some((item) => item.youtubeVideoId === "q0"));
    assert.ok(
        mixes.every(
            (mix) =>
                new Set(mix.tracks.map((item) => item.youtubeVideoId)).size ===
                mix.tracks.length,
        ),
    );
});

test("current time mix remains visible when the account has fewer signals", async () => {
    const { buildHomePersonalMixes, timeOfDayMixForHour } =
        await import("../../features/home/components/HomeMadeForYou");
    const sparseFeed: PersonalizedHomeFeed = {
        ...feed,
        shelves: {
            quickPicks: [track("q1"), track("q2")],
            discovery: [track("d1"), track("d2")],
            listenAgain: [],
        },
    };
    const sparseTimeFeed: PersonalizedHomeFeed = {
        ...timeFeed,
        shelves: {
            quickPicks: [],
            discovery: [track("t1"), track("t2")],
            listenAgain: [],
        },
    };

    const mixes = buildHomePersonalMixes(
        sparseFeed,
        sparseTimeFeed,
        timeOfDayMixForHour(20),
    );
    assert.equal(mixes.length, 4);
    assert.ok(mixes.some((mix) => mix.title === "Ваш вечер"));
    assert.ok(mixes.every((mix) => mix.tracks.length >= 2));
});

test("time-of-day mix can use familiar recommendations when discovery is empty", async () => {
    const { buildHomePersonalMixes, timeOfDayMixForHour } =
        await import("../../features/home/components/HomeMadeForYou");
    const familiarTimeFeed: PersonalizedHomeFeed = {
        ...timeFeed,
        shelves: {
            quickPicks: [track("morning-known")],
            discovery: [],
            listenAgain: [],
        },
    };

    const mixes = buildHomePersonalMixes(
        feed,
        familiarTimeFeed,
        timeOfDayMixForHour(9),
    );
    assert.equal(mixes.at(-1)?.title, "Ваше утро");
    assert.equal(mixes.at(-1)?.tracks[0].youtubeVideoId, "morning-known");
});

test("personal Home mixes can reuse a song across different playlists, never inside one", async () => {
    const { buildHomePersonalMixes } =
        await import("../../features/home/components/HomeMadeForYou");

    const mixes = buildHomePersonalMixes(feed);

    assert.equal(mixes.length, 3);
    assert.deepEqual(
        mixes.map((mix) => mix.title),
        ["Микс дня 1", "Микс дня 2", "Микс дня 3"],
    );
    assert.ok(mixes.every((mix) => mix.tracks.length === 7));
    assert.ok(
        mixes.every(
            (mix) =>
                new Set(mix.tracks.map((item) => item.youtubeVideoId)).size ===
                mix.tracks.length,
        ),
    );
    const identities = mixes.map((mix) =>
        mix.tracks.map((item) => item.youtubeVideoId).join("|"),
    );
    assert.equal(new Set(identities).size, identities.length);
    assert.ok(mixes[0].tracks.some((item) => item.youtubeVideoId === "shared"));
    assert.ok(mixes[1].tracks.some((item) => item.youtubeVideoId === "shared"));
});

test("Home Made For You renders at most five distinct real collections", async () => {
    const { HomeMadeForYou, timeOfDayMixForHour } =
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
            personalizedFeed: richFeed,
            timeOfDayFeed: timeFeed,
            timeOfDayMix: timeOfDayMixForHour(8),
            isRefreshingMixes: false,
            handleRefreshMixes: async () => undefined,
        }),
    );

    assert.match(html, /Миксы для вас/);
    assert.match(html, /data-home-rail="mixes"/);
    assert.match(html, /data-home-mixes-surface="unified"/);
    assert.equal((html.match(/data-home-made-card=/g) ?? []).length, 5);
    assert.match(html, /Микс дня 1/);
    assert.match(html, /Микс дня 2/);
    assert.match(html, /Микс дня 3/);
    assert.match(html, /Ваше утро/);
    assert.match(html, /Открытия недели/);
    assert.doesNotMatch(html, /Mix 0/);
    assert.ok(html.indexOf("Открытия недели") < html.indexOf("Микс дня 1"));
    assert.doesNotMatch(html, /Mix 1/);
    assert.match(html, /aria-controls="home-all-mixes"/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /href="\/playlists"/);
});

test("Home Made For You expands and collapses every collection inline on one surface", async () => {
    const { HomeMadeForYou, timeOfDayMixForHour } =
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
                personalizedFeed: richFeed,
                timeOfDayFeed: timeFeed,
                timeOfDayMix: timeOfDayMixForHour(8),
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
    assert.equal(surface.querySelectorAll("[data-home-made-card]").length, 13);
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
