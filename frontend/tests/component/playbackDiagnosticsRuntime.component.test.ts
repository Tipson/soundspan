import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { advanceAuthRuntimeGeneration } from "../../lib/auth-runtime-generation";
import { createPlaybackDiagnosticQueue } from "../../lib/audio-engine/playbackDiagnosticQueue";

const handlers = new Map<string, Set<() => void>>();
let owner = "user-a";
const sent: Array<{
    event: string;
    fields: Record<string, unknown>;
    diagnostic?: { ownerId: string };
}> = [];
const engine = {
    on(event: string, listener: () => void) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(listener);
    },
    off(event: string, listener: () => void) {
        handlers.get(event)?.delete(listener);
    },
    getActualCurrentTime: () => 3,
    getDuration: () => 180,
    getBufferedAheadSec: () => 177,
    isPlaying: () => false,
    hasTrackEnded: () => false,
    getActiveEngineDescriptor: () => "native",
    getDiagnosticState: () => ({
        nativePaused: true,
        readyState: 4,
        networkState: 1,
        mediaErrorCode: null,
        audioContextState: "not_used",
        sourceKind: "device_file",
    }),
};
mock.module("@/lib/audio-engine", {
    namedExports: { createRuntimeAudioEngine: () => engine },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            reportPlaybackClientMetric: async (
                input: (typeof sent)[number],
            ) => {
                sent.push(input);
            },
        },
    },
});
mock.module("@/lib/auth-offline-session", {
    namedExports: { readCachedAuthUser: () => ({ id: owner }) },
});
const logger = {
    info() {},
    warn() {},
    error() {},
    child() {
        return logger;
    },
};
mock.module("@/lib/logger", { namedExports: { frontendLogger: logger } });
mock.module("@/lib/recommendationSession", {
    namedExports: {
        getRecommendationSessionId: () => "private-listening-session",
    },
});
let runtime: typeof import("../../lib/audio-engine/audioPlaybackOrchestratorRuntime");
const originalBuildId = process.env.NEXT_PUBLIC_SOUNDSPAN_BUILD_ID;
let stop: (() => void) | undefined;
before(async () => {
    process.env.NEXT_PUBLIC_SOUNDSPAN_BUILD_ID = "current-build";
    GlobalRegistrator.register({ url: "https://soundspan.test" });
    runtime =
        await import("../../lib/audio-engine/audioPlaybackOrchestratorRuntime");
});
afterEach(() => {
    stop?.();
    stop = undefined;
    advanceAuthRuntimeGeneration();
    localStorage.clear();
    sessionStorage.clear();
    sent.length = 0;
    owner = "user-a";
});
after(async () => {
    if (originalBuildId === undefined)
        delete process.env.NEXT_PUBLIC_SOUNDSPAN_BUILD_ID;
    else process.env.NEXT_PUBLIC_SOUNDSPAN_BUILD_ID = originalBuildId;
    await GlobalRegistrator.unregister();
});
const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};
const state = () => ({
    loadId: 7,
    hasPlayIntent: true,
    uiIsPlaying: true,
    isLoading: false,
});

test("runtime retains a full native offline incident durably and flushes on online", async () => {
    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: false,
    });
    stop = runtime.beginPlaybackDiagnostics(state);
    handlers.get("pause")?.forEach((listener) => listener());
    await settle();
    assert.equal(sent.length, 0);
    const serialized = Object.values(localStorage).join("");
    assert.ok(serialized.includes("player.engine_pause"));
    assert.equal(serialized.includes("private-listening-session"), false);
    assert.equal(sessionStorage.length, 0);
    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: true,
    });
    window.dispatchEvent(new Event("online"));
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].diagnostic?.ownerId, "user-a");
    const fields = sent[0].fields;
    assert.equal(fields.diagnosticsVersion, 2);
    assert.equal(fields.frontendBuildId, "current-build");
    assert.equal(fields.sourceKind, "device_file");
    assert.equal(fields.localSource, true);
    assert.equal(fields.nativePaused, true);
    assert.equal(fields.hasPlayIntent, true);
    assert.equal(fields.uiIsPlaying, true);
    assert.equal(fields.readyState, 4);
    assert.equal(fields.networkState, 1);
    assert.equal(fields.bufferedAheadSec, 177);
    assert.equal(fields.currentTimeSec, 3);
    assert.equal(fields.engineEnded, false);
    assert.equal(fields.online, false, "capture state precedes upload");
    assert.ok(fields.playbackRunId);
});

test("mount restores an earlier PWA backlog without needing another playback event", async () => {
    const queued = createPlaybackDiagnosticQueue({
        storage: localStorage,
        ownerId: () => owner,
        online: () => false,
        send: async () => {
            throw Error("offline");
        },
    });
    queued.enqueue("player.unexpected_pause", {
        diagnosticsVersion: 2,
        frontendBuildId: "earlier-build",
    });
    queued.dispose();
    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: true,
    });
    stop = runtime.beginPlaybackDiagnostics(state);
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].event, "player.unexpected_pause");
    assert.equal(sent[0].fields.frontendBuildId, "earlier-build");
});

test("auth rotation removes pending account events and retires old native observers", async () => {
    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: false,
    });
    stop = runtime.beginPlaybackDiagnostics(state);
    handlers.get("pause")?.forEach((listener) => listener());
    advanceAuthRuntimeGeneration();
    owner = "user-b";
    handlers.get("end")?.forEach((listener) => listener());
    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: true,
    });
    window.dispatchEvent(new Event("online"));
    await settle();
    assert.equal(sent.length, 0);
    stop();
    stop = runtime.beginPlaybackDiagnostics(state);
    handlers.get("pause")?.forEach((listener) => listener());
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].diagnostic?.ownerId, "user-b");
});
