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
    refresh,
};
mock.module("@/features/device-offline/DeviceOfflineProvider", {
    namedExports: { useDeviceOffline: () => context },
});
mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
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
            view.container.querySelectorAll("p.truncate.text-sm").length,
            1,
        );
    } finally {
        context.queueItems = [];
        view.close();
    }
});
