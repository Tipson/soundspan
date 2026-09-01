import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type LivePlaybackState =
    | "IDLE"
    | "LOADING"
    | "RECOVERING"
    | "READY"
    | "PLAYING"
    | "SEEKING"
    | "BUFFERING"
    | "ERROR";

let livePlaybackState: LivePlaybackState = "IDLE";
let freshPlaybackHeartbeat = false;
const postedMessages: unknown[] = [];

const waitingWorker = {
    postMessage(message: unknown) {
        postedMessages.push(message);
    },
};

const registration = {
    waiting: waitingWorker,
    installing: null,
    scope: "https://music.example/",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
};

const serviceWorker = {
    controller: {},
    register: async () => registration,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
};

mock.module("@/lib/audio/playback-state-machine", {
    namedExports: {
        playbackStateMachine: {
            getState: () => livePlaybackState,
        },
    },
});

mock.module("@/lib/audio/playback-liveness", {
    namedExports: {
        hasFreshPlaybackHeartbeat: () => freshPlaybackHeartbeat,
    },
});

mock.module("@/features/device-offline/legacyBackgroundCleanup", {
    namedExports: {
        createLegacyBackgroundCleanupLoop: () => ({
            trigger: () => undefined,
            stop: () => undefined,
        }),
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        createFrontendLogger: () => ({
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
            debug: () => undefined,
        }),
    },
});

Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: serviceWorker,
});

beforeEach(() => {
    livePlaybackState = "IDLE";
    freshPlaybackHeartbeat = false;
    postedMessages.length = 0;
    localStorage.clear();
});

after(() => {
    GlobalRegistrator.unregister();
});

async function renderRegistration() {
    const { createRoot } = await import("react-dom/client");
    const { ServiceWorkerRegistration } =
        await import("../../components/ServiceWorkerRegistration");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(ServiceWorkerRegistration));
        await Promise.resolve();
        await Promise.resolve();
    });

    return () => {
        React.act(() => root.unmount());
        container.remove();
    };
}

test("a stale persisted playing flag cannot block a waiting worker", async () => {
    localStorage.setItem("soundspan_is_playing", "true");
    livePlaybackState = "IDLE";

    const unmount = await renderRegistration();

    assert.equal(postedMessages.length, 1);
    assert.equal(
        (postedMessages[0] as { type?: string } | undefined)?.type,
        "SKIP_WAITING",
    );
    unmount();
});

test("a confirmed live playback session defers the waiting worker", async () => {
    localStorage.setItem("soundspan_is_playing", "false");
    livePlaybackState = "PLAYING";
    freshPlaybackHeartbeat = true;

    const unmount = await renderRegistration();

    assert.equal(postedMessages.length, 0);

    livePlaybackState = "READY";
    await React.act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await Promise.resolve();
    });
    assert.equal(postedMessages.length, 1);
    assert.equal(
        (postedMessages[0] as { type?: string } | undefined)?.type,
        "SKIP_WAITING",
    );
    unmount();
});

test("a stuck playback state without a fresh heartbeat cannot block an update", async () => {
    livePlaybackState = "PLAYING";
    freshPlaybackHeartbeat = false;

    const unmount = await renderRegistration();

    assert.equal(postedMessages.length, 1);
    assert.equal(
        (postedMessages[0] as { type?: string } | undefined)?.type,
        "SKIP_WAITING",
    );
    unmount();
});
