import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DeviceOfflineDownloadRecord } from "../../features/device-offline/types";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let records: DeviceOfflineDownloadRecord[] = [];
let plays = 0;
let currentTrack: { id: string; playbackSourcePolicy?: "device-only" } | null =
    null;
let isPlaying = false;
let pauses = 0;
let resumes = 0;
let queuedTracks: Array<{ id: string; playbackSourcePolicy?: string }> = [];
let queueWasReplaced = false;
mock.module("@/lib/audio-state-context", {
    namedExports: { useAudioState: () => ({ currentTrack }) },
});
mock.module("@/lib/audio-playback-context", {
    namedExports: { usePlaybackStatus: () => ({ isPlaying }) },
});
const refresh = async () => undefined;
const context = {
    isHydrated: true,
    isQueueHydrated: true,
    storageError: null,
    get records() {
        return records;
    },
    queueItems: [] as Array<Record<string, unknown>>,
    capability: { explanation: "" },
    storage: {
        status: "ready",
        storageKind: "browser-private",
        explanation: "",
    },
    legacyStorage: null,
    preparePlayback: async () => undefined,
    refresh,
};
mock.module("@/features/device-offline/DeviceOfflineProvider", {
    namedExports: { useDeviceOffline: () => context },
});
mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: (
                tracks: typeof queuedTracks,
                _index: number,
                _vibe: boolean,
                options?: { replaceQueue?: boolean },
            ) => {
                queuedTracks = tracks;
                queueWasReplaced = options?.replaceQueue === true;
            },
            pause: () => {
                pauses += 1;
            },
            resume: () => {
                resumes += 1;
            },
            playNow: () => {
                plays += 1;
            },
        }),
    },
});
mock.module("sonner", { namedExports: { toast: { error() {} } } });

function record(
    id: string,
    title: string,
    artist: string,
    album: string,
): DeviceOfflineDownloadRecord {
    return {
        key: id,
        ownerId: "test",
        trackIdentity: `local:${id}`,
        quality: "auto",
        virtualUrl: `/__offline/${id}`,
        sourceUrl: `/api/library/${id}`,
        track: {
            id,
            title,
            artist: { name: artist },
            album: { title: album },
            duration: 180,
        },
        status: "ready",
        transferMode: "foreground",
        backgroundFetchId: null,
        bytesReceived: 100,
        totalBytes: 100,
        contentType: "audio/mpeg",
        persistenceGranted: true,
        attempt: 1,
        createdAt: 1,
        updatedAt: 1,
        errorCode: null,
        errorMessage: null,
    };
}

async function mount() {
    const { createRoot } = await import("react-dom/client");
    const { DownloadsList } =
        await import("../../features/device-offline/components/DownloadsList");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = () =>
        React.act(async () => root.render(React.createElement(DownloadsList)));
    await render();
    return {
        container,
        render,
        async search(value: string) {
            const input = container.querySelector<HTMLInputElement>(
                'input[type="search"]',
            );
            assert.ok(
                input,
                "Downloads must expose an accessible local search",
            );
            await React.act(async () => {
                Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype,
                    "value",
                )!.set!.call(input, value);
                input.dispatchEvent(new Event("input", { bubbles: true }));
            });
            return input;
        },
        titles: () =>
            [
                ...container.querySelectorAll(
                    "[data-download-status] p:first-child",
                ),
            ].map((node) => node.textContent),
        close() {
            React.act(() => root.unmount());
            container.remove();
        },
    };
}

after(() => GlobalRegistrator.unregister());

test("starting the same track from Downloads replaces an online queue with device-only occurrences", async () => {
    records = [
        record("a", "Numb", "Linkin Park", "Meteora"),
        record("b", "Faint", "Linkin Park", "Meteora"),
    ];
    currentTrack = { id: "a" };
    isPlaying = true;
    const view = await mount();
    try {
        const button = view.container.querySelector<HTMLButtonElement>(
            'button[aria-label="Воспроизвести: Numb"]',
        );
        assert.ok(button);
        await React.act(async () => button.click());
        assert.equal(queueWasReplaced, true);
        assert.deepEqual(
            queuedTracks.map((t) => t.id),
            ["a", "b"],
        );
        assert.ok(
            queuedTracks.every((t) => t.playbackSourcePolicy === "device-only"),
        );
        assert.equal(currentTrack.playbackSourcePolicy, undefined);
        assert.ok(records.every((r) => !("playbackSourcePolicy" in r.track)));
    } finally {
        currentTrack = null;
        isPlaying = false;
        queuedTracks = [];
        queueWasReplaced = false;
        view.close();
    }
});

test("download row follows player selection and pause without replacing the queue", async () => {
    records = [
        record("a", "Numb", "Linkin Park", "Meteora"),
        record("b", "Faint", "Linkin Park", "Meteora"),
    ];
    currentTrack = { id: "a", playbackSourcePolicy: "device-only" };
    isPlaying = true;
    const view = await mount();
    try {
        const pause = view.container.querySelector<HTMLButtonElement>(
            'button[aria-label="Пауза: Numb"]',
        );
        assert.ok(pause);
        assert.ok(
            pause
                .closest("[data-download-status]")!
                .querySelector('p [data-playback-state="playing"]'),
        );
        assert.match(
            pause.closest("[data-download-status]")!.textContent!,
            /Играет/,
        );
        await React.act(async () => pause.click());
        assert.equal(pauses, 1);
        isPlaying = false;
        await view.render();
        const play = view.container.querySelector<HTMLButtonElement>(
            'button[aria-label="Воспроизвести: Numb"]',
        );
        assert.ok(play);
        assert.ok(
            play
                .closest("[data-download-status]")!
                .querySelector('p [data-playback-state="paused"]'),
        );
        assert.match(
            play.closest("[data-download-status]")!.textContent!,
            /На паузе/,
        );
        await React.act(async () => play.click());
        assert.equal(resumes, 1);
        currentTrack = { id: "b", playbackSourcePolicy: "device-only" };
        isPlaying = true;
        await view.render();
        assert.ok(
            view.container.querySelector('button[aria-label="Пауза: Faint"]'),
        );
        assert.equal(
            view.container.querySelectorAll('[aria-current="true"]').length,
            1,
        );
    } finally {
        currentTrack = null;
        isPlaying = false;
        view.close();
    }
});

test("downloads search combines artist, title and album without starting playback", async () => {
    records = [
        record("a", "Numb", "Linkin Park", "Meteora"),
        record("b", "Going Under", "Evanescence", "Fallen"),
    ];
    const view = await mount();
    try {
        await view.search("  METEORA   linkin ");
        assert.deepEqual(view.titles(), ["Numb"]);
        await view.search("under");
        assert.deepEqual(view.titles(), ["Going Under"]);
        assert.equal(plays, 0);
        await view.search("   ");
        assert.equal(view.titles().length, 2);
    } finally {
        view.close();
    }
});

test("downloads search tolerates Russian yo and retains query during background updates", async () => {
    records = [record("a", "Ёлки", "Артист", "Зима")];
    const view = await mount();
    try {
        const input = await view.search("елки");
        assert.deepEqual(view.titles(), ["Ёлки"]);
        const row = view.container.querySelector("[data-download-status]");
        records = [
            { ...records[0], updatedAt: 500 },
            record("b", "Другой", "Артист", "Зима"),
        ];
        await view.render();
        assert.equal(input.value, "елки");
        assert.strictEqual(
            view.container.querySelector("[data-download-status]"),
            row,
        );
        assert.deepEqual(view.titles(), ["Ёлки"]);
    } finally {
        view.close();
    }
});

test("no matches offers clearing search, including after the last download is removed", async () => {
    records = [record("a", "Numb", "Linkin Park", "Meteora")];
    const view = await mount();
    try {
        await view.search("missing");
        assert.equal(view.titles().length, 0);
        assert.match(view.container.textContent ?? "", /Ничего не найдено/);
        records = [];
        await view.render();
        const clear = view.container.querySelector<HTMLButtonElement>(
            'button[aria-label="Очистить поиск"]',
        );
        assert.ok(clear);
        await React.act(async () => clear.click());
        assert.match(
            view.container.textContent ?? "",
            /На этом устройстве нет загрузок/,
        );
    } finally {
        view.close();
    }
});

test("queued downloads are searchable and remain deduplicated against stored copies", async () => {
    const copy = record("a", "Numb", "Linkin Park", "Meteora");
    records = [copy];
    context.queueItems = [
        { ...copy, status: "queued" },
        { ...record("b", "Faint", "Linkin Park", "Meteora"), status: "queued" },
    ];
    const view = await mount();
    try {
        await view.search("faint");
        assert.match(view.container.textContent ?? "", /Faint/);
        assert.doesNotMatch(view.container.textContent ?? "", /Numb/);
        await view.search("numb");
        assert.equal(
            view.container.querySelectorAll("[data-download-status]").length,
            1,
        );
    } finally {
        context.queueItems = [];
        view.close();
    }
});
