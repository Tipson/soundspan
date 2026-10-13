import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Episode } from "../../features/podcast/types";

GlobalRegistrator.register({ url: "http://localhost/podcasts/test" });
(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());
const queueCalls: string[] = [];
const navigations: string[] = [];
mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            addEpisodeToQueue: (episode: Episode) =>
                queueCalls.push(episode.id),
            playEpisodeNext: (episode: Episode) =>
                queueCalls.push(`next:${episode.id}`),
        }),
    },
});
mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({ push: (href: string) => navigations.push(href) }),
    },
});
mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: false,
            triggerPlayFeedback() {},
        }),
    },
});
const episode: Episode = {
    id: "episode-a",
    title: "О музыке и людях",
    publishedAt: "2026-10-12",
    duration: 240,
};

test("episode actions escape clipped rows, execute queue actions once and return focus", async () => {
    const { EpisodeOverflowMenu } =
        await import("../../features/podcast/components/EpisodeOverflowMenu");
    const host = document.createElement("div");
    host.style.overflow = "hidden";
    document.body.append(host);
    const root = createRoot(host);
    try {
        await act(async () =>
            root.render(
                React.createElement(EpisodeOverflowMenu, {
                    episode,
                    podcast: { id: "p1", title: "Подкаст", coverUrl: null },
                }),
            ),
        );
        const trigger = host.querySelector<HTMLButtonElement>("button");
        assert.ok(trigger);
        await act(async () => {
            trigger.focus();
            trigger.click();
        });
        const dialog = document.querySelector('[role="dialog"]');
        assert.ok(dialog, "episode actions use the shared accessible overlay");
        assert.equal(host.contains(dialog), false);
        const next = dialog.querySelector<HTMLButtonElement>(
            '[title="Воспроизвести следующим"]',
        );
        assert.ok(next);
        await act(async () => next.click());
        assert.deepEqual(queueCalls, ["next:episode-a"]);
        assert.equal(document.querySelector('[role="dialog"]'), null);
        assert.equal(document.activeElement, trigger);
        await act(async () => trigger.click());
        const add = document.querySelector<HTMLButtonElement>(
            '[title="Добавить в очередь"]',
        );
        assert.ok(add);
        await act(async () => add.click());
        assert.deepEqual(queueCalls, ["next:episode-a", "episode-a"]);
        await act(async () => trigger.click());
        await act(async () =>
            window.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Escape" }),
            ),
        );
        assert.equal(document.querySelector('[role="dialog"]'), null);
        assert.equal(document.activeElement, trigger);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

test("related podcast cards are keyboard-focusable controls with their existing route", async () => {
    const { SimilarPodcasts } =
        await import("../../features/podcast/components/SimilarPodcasts");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
        await act(async () =>
            root.render(
                React.createElement(SimilarPodcasts, {
                    podcasts: [
                        { id: "p2", title: "О музыке", author: "Автор" },
                    ],
                }),
            ),
        );
        const card = host.querySelector<HTMLButtonElement>("button");
        assert.ok(card);
        card.focus();
        assert.equal(document.activeElement, card);
        await act(async () => card.click());
        assert.deepEqual(navigations, ["/podcasts/p2"]);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

test("subscribed podcast removal retains an accessible name when its mobile text is hidden", async () => {
    const { PodcastActionBar } =
        await import("../../features/podcast/components/PodcastActionBar");
    const host = document.createElement("div");
    const root = createRoot(host);
    let confirming = false;
    try {
        await act(async () =>
            root.render(
                React.createElement(PodcastActionBar, {
                    isSubscribed: true,
                    colors: null,
                    isSubscribing: false,
                    showDeleteConfirm: false,
                    onSubscribe() {},
                    onRemove() {},
                    onShowDeleteConfirm: (value) => {
                        confirming = value;
                    },
                }),
            ),
        );
        const remove = host.querySelector<HTMLButtonElement>(
            '[aria-label="Удалить подкаст"]',
        );
        assert.ok(remove);
        await act(async () => remove.click());
        assert.equal(confirming, true);
    } finally {
        await act(async () => root.unmount());
    }
});

test("episode rows support keyboard play and isolated native pause and completion actions", async () => {
    const { EpisodeList } =
        await import("../../features/podcast/components/EpisodeList");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const calls: string[] = [];
    const podcast = {
        id: "p1",
        title: "Подкаст",
        author: "Автор",
        coverUrl: "",
        autoDownloadEpisodes: false,
        episodes: [episode],
    };
    const render = async (playing: boolean) =>
        act(async () =>
            root.render(
                React.createElement(EpisodeList, {
                    podcast,
                    episodes: [episode],
                    sortOrder: "newest",
                    onSortOrderChange() {},
                    isEpisodePlaying: () => playing,
                    isPlaying: playing,
                    onPlayPause: (value) => calls.push(`pause:${value.id}`),
                    onPlay: (value) => calls.push(`play:${value.id}`),
                    onMarkComplete: (id) => calls.push(`complete:${id}`),
                }),
            ),
        );
    try {
        await render(false);
        const row = host.querySelector<HTMLElement>(
            '[role="button"][tabindex="0"]',
        );
        assert.ok(row);
        await act(async () =>
            row.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
            ),
        );
        assert.deepEqual(calls, ["play:episode-a"]);
        const complete = host.querySelector<HTMLButtonElement>(
            '[title="Отметить прослушанным"]',
        );
        assert.ok(complete);
        await act(async () => complete.click());
        assert.deepEqual(calls, ["play:episode-a", "complete:episode-a"]);
        const actions = host.querySelector<HTMLButtonElement>(
            '[aria-label="Действия с выпуском"]',
        );
        assert.ok(actions);
        await act(async () => {
            actions.focus();
            actions.click();
        });
        const close = document.querySelector<HTMLButtonElement>(
            '[role="dialog"] button[aria-label="Закрыть"]',
        );
        assert.ok(close);
        await act(async () => close.click());
        assert.deepEqual(calls, ["play:episode-a", "complete:episode-a"]);
        await render(true);
        const pause = host.querySelector<HTMLButtonElement>(
            '[aria-label="Пауза: О музыке и людях"]',
        );
        assert.ok(pause);
        await act(async () => pause.click());
        assert.deepEqual(calls, [
            "play:episode-a",
            "complete:episode-a",
            "pause:episode-a",
        ]);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

test("continue listening exposes named native controls for current and neighboring episodes", async () => {
    const { ContinueListening } =
        await import("../../features/podcast/components/ContinueListening");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const calls: string[] = [];
    const recent = {
        ...episode,
        progress: {
            currentTime: 60,
            progress: 25,
            isFinished: false,
            lastPlayedAt: new Date("2026-10-12"),
        },
    };
    const previous = { ...episode, id: "previous", title: "Предыдущий" };
    const next = { ...episode, id: "next", title: "Следующий" };
    try {
        await act(async () =>
            root.render(
                React.createElement(ContinueListening, {
                    podcast: {
                        id: "p1",
                        title: "Подкаст",
                        author: "Автор",
                        coverUrl: "",
                        autoDownloadEpisodes: false,
                        episodes: [recent],
                    },
                    inProgressEpisodes: [recent],
                    sortedEpisodes: [previous, recent, next],
                    isEpisodePlaying: () => true,
                    isPlaying: true,
                    onPlayEpisode: (value) => calls.push(value.id),
                    onPlayPause: (value) => calls.push(`pause:${value.id}`),
                }),
            ),
        );
        const controls = Array.from(
            host.querySelectorAll<HTMLButtonElement>("button"),
        );
        assert.equal(controls.length, 3);
        assert.equal(
            controls[1].getAttribute("aria-label"),
            "Пауза: О музыке и людях",
        );
        for (const control of controls) await act(async () => control.click());
        assert.deepEqual(calls, ["previous", "pause:episode-a", "next"]);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
