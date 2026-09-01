import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
    played: [] as Array<{ tracks: unknown[]; index: number }>,
};

const Icon = () => React.createElement("svg");

mock.module("lucide-react", {
    namedExports: { Music: Icon, Play: Icon },
});
mock.module("@/lib/api", {
    namedExports: {
        api: { getCoverArtUrl: (cover: string) => `/covers/${cover}` },
    },
});
mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: (tracks: unknown[], index: number) =>
                state.played.push({ tracks, index }),
        }),
    },
});
mock.module("@/components/ui/CachedImage", {
    namedExports: {
        CachedImage: ({ alt }: { alt: string }) =>
            React.createElement("img", { alt }),
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {}
});

beforeEach(() => {
    state.played.length = 0;
});

const makeTrack = (id: string) => ({
    id: `yt:${id}`,
    title: `Track ${id}`,
    duration: 180,
    trackNo: null,
    artist: { id: null, name: `Artist ${id}` },
    album: { id: null, title: `Album ${id}`, coverArt: `cover-${id}` },
    source: "youtube" as const,
    provider: { tidalTrackId: null, youtubeVideoId: id },
    streamSource: "youtube" as const,
    youtubeVideoId: id,
});

async function mount(element: React.ReactElement) {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => root.render(element));
    return {
        container,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("listening dashboard splits one unique queue into continuation cards and recent rows", async () => {
    const { HomeListeningDashboard } =
        await import("../../features/home/components/HomeListeningDashboard");
    const tracks = [
        makeTrack("a"),
        makeTrack("b"),
        makeTrack("c"),
        makeTrack("d"),
        makeTrack("e"),
        makeTrack("f"),
        makeTrack("a"),
    ];
    const mounted = await mount(
        React.createElement(HomeListeningDashboard, { tracks }),
    );

    assert.equal(
        mounted.container.querySelectorAll(
            '[data-home-region="continue-listening"] [role="listitem"]',
        ).length,
        4,
    );
    assert.equal(
        mounted.container.querySelectorAll(
            '[data-home-region="recently-played"] [role="listitem"]',
        ).length,
        2,
    );
    assert.equal(
        mounted.container.querySelectorAll('[data-track-id="yt:a"]').length,
        1,
    );

    const recentTrack = mounted.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Воспроизвести «Track e», исполнитель Artist e"]',
    );
    assert.ok(recentTrack);
    await React.act(async () => recentTrack.click());
    assert.equal(state.played.length, 1);
    assert.equal(state.played[0].index, 4);
    assert.equal(state.played[0].tracks.length, 6);
    assert.ok(
        recentTrack.classList.contains("min-w-0") &&
            recentTrack.classList.contains("max-w-full") &&
            recentTrack.classList.contains("overflow-hidden"),
        "long recent-track titles must stay inside the fixed dashboard column",
    );
    assert.ok(
        recentTrack.querySelector("span.min-w-0.flex-1 .truncate"),
        "recent-track text must ellipsize without moving the play control",
    );

    const continuationGrid = mounted.container.querySelector<HTMLElement>(
        '[data-home-region="continue-listening"] [role="list"]',
    );
    assert.ok(continuationGrid);
    assert.ok(
        continuationGrid.classList.contains(
            "xl:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]",
        ),
        "desktop columns should respond to the available dashboard width so 1280px keeps three readable cards and the 1487px reference fits four",
    );

    const playOverlay = mounted.container.querySelector<HTMLElement>(
        "[data-home-play-overlay]",
    );
    assert.ok(playOverlay, "continuation artwork should expose a play overlay");
    assert.ok(
        playOverlay.classList.contains("bg-white/80"),
        "the hover play control should remain translucent over artwork",
    );
    assert.ok(playOverlay.classList.contains("opacity-0"));
    assert.ok(playOverlay.classList.contains("group-hover:opacity-100"));

    await mounted.unmount();
});

test("listening dashboard renders no empty sections", async () => {
    const { HomeListeningDashboard } =
        await import("../../features/home/components/HomeListeningDashboard");
    const mounted = await mount(
        React.createElement(HomeListeningDashboard, { tracks: [] }),
    );
    assert.equal(mounted.container.innerHTML, "");
    await mounted.unmount();
});
