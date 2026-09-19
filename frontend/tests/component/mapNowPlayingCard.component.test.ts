import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
mock.module("@/lib/api", {
    namedExports: { api: { getCoverArtUrl: () => "/cover.jpg" } },
});
mock.module("next/link", {
    defaultExport: (props: React.ComponentProps<"a">) =>
        React.createElement("a", props),
});
after(() => GlobalRegistrator.unregister());

test("map card retains playback, location, progress and track links", async () => {
    const { NowPlayingCard } =
        await import("../../components/vibe/NowPlayingCard");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let toggles = 0;
    let locations = 0;
    await React.act(async () =>
        root.render(
            React.createElement(NowPlayingCard, {
                track: {
                    id: "track",
                    title: "Test",
                    artist: { id: "artist", name: "Artist" },
                    album: { id: "album" },
                },
                isPlaying: true,
                onMapPresent: true,
                currentTime: 30,
                duration: 120,
                onTogglePlay: () => {
                    toggles += 1;
                },
                onFlyTo: () => {
                    locations += 1;
                },
            }),
        ),
    );
    const pause = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Пауза"]',
    );
    assert.ok(pause);
    await React.act(async () => pause.click());
    assert.equal(toggles, 1);
    const locate = container.querySelector<HTMLButtonElement>("button");
    assert.ok(locate);
    await React.act(async () => locate.click());
    assert.equal(locations, 1);
    assert.equal(
        container
            .querySelector('[role="progressbar"]')
            ?.getAttribute("aria-valuenow"),
        "25",
    );
    assert.equal(
        container.querySelector('a[href="/album/album"]')?.textContent,
        "Test",
    );
    assert.equal(
        container.querySelector('a[href="/artist/artist"]')?.textContent,
        "Artist",
    );
    await React.act(async () =>
        root.render(
            React.createElement(NowPlayingCard, {
                track: null,
                isPlaying: false,
                onMapPresent: false,
                onTogglePlay: () => undefined,
                onFlyTo: () => undefined,
            }),
        ),
    );
    assert.equal(container.innerHTML, "");
    await React.act(async () => root.unmount());
    container.remove();
});
