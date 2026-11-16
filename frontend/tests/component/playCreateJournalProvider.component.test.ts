import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
    advanceAuthRuntimeGeneration,
    getAuthRuntimeLease,
} from "../../lib/auth-runtime-generation";
import { createPlayJournalDeliveryScope } from "../../lib/playCreateJournalBridge";
import type { PlayCreateJournalRuntimeOptions } from "../../lib/playCreateJournalRuntime";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
type Record = {
    options: PlayCreateJournalRuntimeOptions;
    events: string[];
    wakes: number;
};
const records: Record[] = [];
const state = {
    isAuthenticated: true,
    ownerId: "alice" as string | null,
    path: "/",
};
const api = {};
mock.module("@/lib/api", { namedExports: { api } });
mock.module("@/lib/playCreateJournalRuntime", {
    namedExports: {
        createPlayCreateJournalRuntime(
            options: PlayCreateJournalRuntimeOptions,
        ) {
            const record: Record = { options, events: [], wakes: 0 };
            records.push(record);
            return {
                begin() {
                    record.events.push("begin");
                    return { mode: "keyed" };
                },
                prepare() {
                    record.events.push("prepare");
                    return new Promise<void>(() => undefined);
                },
                wake() {
                    record.wakes++;
                },
                async close() {
                    record.events.push("close");
                },
                suspendForHistoryClear() {
                    return async () => undefined;
                },
            };
        },
    },
});
mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({
            isAuthenticated: state.isAuthenticated,
            user: state.ownerId ? { id: state.ownerId } : null,
        }),
    },
});
mock.module("next/navigation", {
    namedExports: { usePathname: () => state.path },
});
const Passthrough = ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
for (const [specifier, exported] of [
    ["@/lib/audio-state-context", "AudioStateProvider"],
    ["@/lib/audio-playback-context", "AudioPlaybackProvider"],
    ["@/lib/audio-controls-context", "AudioControlsProvider"],
    ["@/lib/listen-together-context", "ListenTogetherProvider"],
    ["@/components/providers/AudioErrorBoundary", "AudioErrorBoundary"],
])
    mock.module(specifier, { namedExports: { [exported]: Passthrough } });
mock.module("@/features/device-offline/DeviceOfflineProvider", {
    namedExports: {
        DeviceOfflineProvider: Passthrough,
        useDeviceOffline: () => ({ isHydrated: true }),
    },
});
mock.module("@/components/player/AudioRuntimeElement", {
    namedExports: { AudioRuntimeElement: () => null },
});
mock.module("@/components/providers/WaveSelectionSynchronizer", {
    namedExports: { WaveSelectionSynchronizer: () => null },
});
let root: Root | null = null,
    container: HTMLDivElement | null = null;
beforeEach(() => {
    advanceAuthRuntimeGeneration();
    records.length = 0;
    state.ownerId = "alice";
    state.isAuthenticated = true;
    state.path = "/";
    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        writable: true,
        value: true,
    });
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        writable: true,
        value: "visible",
    });
});
afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
});
after(() => GlobalRegistrator.unregister());
async function render(element: React.ReactNode) {
    if (!root) {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
    }
    await act(async () => root!.render(element));
}
const play = {
    youtubeVideoId: "video",
    title: "Song",
    artist: "Artist",
    album: "Album",
    duration: 100,
};
function Child() {
    useEffect(() => {
        const scope = createPlayJournalDeliveryScope(getAuthRuntimeLease());
        scope.begin(play);
        return scope.registerFinalizer(() =>
            records.at(-1)!.events.push("final"),
        );
    }, []);
    return React.createElement("span", null, "ready");
}
test("layout installation uses the mounted owner and never waits for prepare before showing children", async () => {
    const { PlayCreateJournalProvider } =
        await import("../../components/providers/PlayCreateJournalProvider");
    await render(
        React.createElement(
            PlayCreateJournalProvider,
            { ownerId: "alice" },
            React.createElement(Child),
        ),
    );
    assert.equal(container!.textContent, "ready");
    assert.equal(records.length, 1);
    assert.equal(records[0].options.ownerId, "alice");
    assert.equal(records[0].options.api, api);
    assert.deepEqual(records[0].events, ["prepare", "begin"]);
    assert.match(records[0].options.nonce(), /^[A-Za-z0-9_-]{32}$/);
    await act(async () => root!.unmount());
    root = null;
    assert.deepEqual(records[0].events, ["prepare", "begin", "final", "close"]);
});
test("network generations change across observed cycles and only visible positive events wake delivery", async () => {
    const { PlayCreateJournalProvider } =
        await import("../../components/providers/PlayCreateJournalProvider");
    await render(
        React.createElement(PlayCreateJournalProvider, { ownerId: "alice" }),
    );
    const record = records[0];
    const before = record.options.network.getGeneration();
    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        writable: true,
        value: false,
    });
    window.dispatchEvent(new Event("offline"));
    assert.equal(record.options.network.isOnline(), false);
    assert.equal(record.options.network.getGeneration(), before + 1);
    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        writable: true,
        value: true,
    });
    window.dispatchEvent(new Event("online"));
    assert.equal(record.options.network.isOnline(), true);
    assert.equal(record.options.network.getGeneration(), before + 2);
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        writable: true,
        value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    const hiddenWakes = record.wakes;
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        writable: true,
        value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(record.wakes, hiddenWakes + 1);
    await act(async () => root!.unmount());
    root = null;
    const stopped = record.wakes;
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(record.wakes, stopped);
});
test("auth revocation immediately withdraws the provider's captured lease", async () => {
    const { PlayCreateJournalProvider } =
        await import("../../components/providers/PlayCreateJournalProvider");
    await render(
        React.createElement(PlayCreateJournalProvider, { ownerId: "alice" }),
    );
    const lease = records[0].options.auth;
    assert.equal(lease.isCurrent(), true);
    advanceAuthRuntimeGeneration();
    assert.equal(lease.isCurrent(), false);
    assert.equal(lease.signal!.aborted, true);
});
test("StrictMode setup-cleanup-setup leaves only the current journal installed", async () => {
    const { PlayCreateJournalProvider } =
        await import("../../components/providers/PlayCreateJournalProvider");
    await render(
        React.createElement(
            React.StrictMode,
            null,
            React.createElement(
                PlayCreateJournalProvider,
                { ownerId: "alice" },
                React.createElement(Child),
            ),
        ),
    );
    assert.equal(records.length, 2);
    assert.equal(records[0].events.filter((v) => v === "close").length, 1);
    assert.equal(records[1].events.includes("close"), false);
    createPlayJournalDeliveryScope(getAuthRuntimeLease()).begin(play);
    assert.equal(records[1].events.filter((v) => v === "begin").length, 2);
});
test("ConditionalAudioProvider excludes public pages and recreates audio accounting for another owner", async () => {
    const { ConditionalAudioProvider } =
        await import("../../components/providers/ConditionalAudioProvider");
    const tree = () =>
        React.createElement(
            ConditionalAudioProvider,
            null,
            React.createElement("span", null, "page"),
        );
    state.path = "/login";
    await render(tree());
    assert.equal(records.length, 0);
    state.path = "/";
    await render(tree());
    assert.equal(records[0].options.ownerId, "alice");
    state.ownerId = "bob";
    await render(tree());
    assert.equal(records.length, 2);
    assert.equal(records[1].options.ownerId, "bob");
    assert.ok(records[0].events.includes("close"));
    state.isAuthenticated = false;
    await render(tree());
    assert.ok(records[1].events.includes("close"));
});
test("a new logical login remounts accounting even when the owner ID is unchanged", async () => {
    const { ConditionalAudioProvider } =
        await import("../../components/providers/ConditionalAudioProvider");
    const tree = () =>
        React.createElement(
            ConditionalAudioProvider,
            null,
            React.createElement("span", null, "page"),
        );
    await render(tree());
    assert.equal(records.length, 1);
    advanceAuthRuntimeGeneration();
    await render(tree());
    assert.equal(records.length, 2);
    assert.equal(records[1].options.auth.isCurrent(), true);
    assert.ok(records[0].events.includes("close"));
});
