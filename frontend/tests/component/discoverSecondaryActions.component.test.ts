import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DiscoverPlaylist } from "../../features/discover/types";

GlobalRegistrator.register({ url: "http://localhost/discover" });
(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: false,
            triggerPlayFeedback: () => undefined,
        }),
    },
});

test("discovery keeps playback visible and collection actions in the shared dismissible sheet", async () => {
    const { DiscoverActionBar } =
        await import("../../features/discover/components/DiscoverActionBar");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const selected: string[] = [];
    const playlist = {
        weekStart: "2026-10-12",
        kind: "online-weekly",
        tracks: [{ id: "t1" }],
    } as DiscoverPlaylist;
    await act(async () =>
        root.render(
            React.createElement(DiscoverActionBar, {
                playlist,
                config: null,
                isPlaylistPlaying: false,
                isPlaying: false,
                onPlayToggle: () => selected.push("play"),
                onShuffle: () => selected.push("shuffle"),
                onAddAllToQueue: () => selected.push("queue"),
                onAddToPlaylist: () => selected.push("playlist"),
                onGenerate: () => selected.push("generate"),
                onToggleSettings: () => selected.push("settings"),
                isGenerating: false,
            }),
        ),
    );
    assert.equal(host.querySelectorAll("button").length, 3);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    const play = host.querySelector<HTMLButtonElement>(
        '[aria-label="Воспроизвести всё"]',
    );
    const shuffle = host.querySelector<HTMLButtonElement>(
        '[aria-label="Перемешать всё"]',
    );
    const more = host.querySelector<HTMLButtonElement>(
        '[aria-label="Ещё действия"]',
    );
    assert.ok(play && shuffle && more);
    await act(async () => {
        play.click();
        shuffle.click();
        more.focus();
        more.click();
    });
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(host.contains(dialog), false);
    assert.equal(dialog.textContent?.includes("Собрать заново"), false);
    assert.equal(dialog.textContent?.includes("Настройки"), false);
    const queue = Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent === "Добавить всё в очередь",
    );
    assert.ok(queue);
    await act(async () => queue.click());
    assert.deepEqual(selected, ["play", "shuffle", "queue"]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, more);
    await act(async () => more.click());
    const add = Array.from(
        document.querySelectorAll('[role="dialog"] button'),
    ).find((button) => button.textContent === "Добавить всё в плейлист");
    assert.ok(add);
    await act(async () => (add as HTMLButtonElement).click());
    assert.deepEqual(selected, ["play", "shuffle", "queue", "playlist"]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => more.click());
    await act(async () =>
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => root.unmount());
    host.remove();
});
