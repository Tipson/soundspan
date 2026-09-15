import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Track } from "../../lib/audio-state-context";
import type { AudioEngineErrorPayload } from "../../lib/audio-engine/types";
import type { ServerSourceRecoveryOutcome } from "../../lib/audio/serverMusicSourceRecovery";
import { audioSeekEmitter } from "../../lib/audio-seek-emitter";
import { advanceAuthRuntimeGeneration } from "../../lib/auth-runtime-generation";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const actions: unknown[][] = [];
const audioEngine = {
    load: (...args: unknown[]) => {
        actions.push(["load", ...args]);
    },
    stop: () => {
        actions.push(["stop"]);
    },
    pause: () => {
        actions.push(["pause"]);
    },
    play: () => {
        actions.push(["play"]);
    },
    seek: (value: number) => {
        actions.push(["seek", value]);
    },
    getCurrentTime: () => 73.5,
    getActualCurrentTime: () => 73.5,
    isPlaying: () => false,
    hasTrackEnded: () => false,
    on: (event: string, cb: (payload: unknown) => void) => {
        const list = listeners.get(event) ?? new Set();
        list.add(cb);
        listeners.set(event, list);
    },
    off: (event: string, cb: (payload: unknown) => void) => {
        listeners.get(event)?.delete(cb);
    },
};
let resolveRequest!: (value: string | null) => void;
let requestSignal: AbortSignal | undefined;
const request = mock.fn((_recording: unknown, signal: AbortSignal) => {
    requestSignal = signal;
    return new Promise<string | null>((resolve) => {
        resolveRequest = resolve;
    });
});
mock.module("@/lib/api", {
    namedExports: { api: { resolveMusicSourceForRecovery: request } },
});
mock.module("@/lib/audio-engine/audioPlaybackOrchestratorRuntime", {
    namedExports: { audioEngine, logPlaybackClientMetric: () => {} },
});
let listenTogether = false;
mock.module("@/lib/listen-together-session", {
    namedExports: { isListenTogetherActiveOrPending: () => listenTogether },
});
const track: Track = {
    id: "yt:original001",
    title: "Recording",
    artist: { name: "Artist" },
    album: { title: "Album" },
    duration: 240,
    streamSource: "youtube",
    youtubeVideoId: "original001",
    playlistItemId: "entry-1",
};
let selected = track,
    playing = true,
    progress = true;
let attempt!: (
    payload: AudioEngineErrorPayload,
) => Promise<ServerSourceRecoveryOutcome>;
let savedPosition = 0;
let playbackSourceUrl = "/api/ytmusic/stream/original001";
let recoveryHoldsEvents!: () => boolean;
let hook: typeof import("../../components/player/hooks/useServerMusicSourceRecovery");
let refsHook: typeof import("../../components/player/hooks/usePlaybackOrchestratorRefs");
let helpersHook: typeof import("../../components/player/hooks/usePlaybackRecoveryHelpers");
const failed: AudioEngineErrorPayload = {
    error: new Error("MEDIA_ERR_NETWORK"),
    code: "2",
    recoverable: false,
};
function Probe() {
    const refs = refsHook.usePlaybackOrchestratorRefs({
        currentTrack: selected,
        playbackType: "track",
        queueLength: 2,
        isPlaying: playing,
        volume: 1,
        isMuted: false,
    });
    React.useLayoutEffect(() => {
        refs.currentTrackRef.current = selected;
        refs.lastPlayingStateRef.current = playing;
        refs.loadIdRef.current = selected === track ? 1 : 2;
        refs.activeEngineTrackIdRef.current = selected.id;
        refs.currentTimeSnapshotRef.current = 73.5;
        refs.currentTimeSnapshotTrackIdRef.current = selected.id;
        refs.startupStabilityRef.current = {
            trackId: selected.id,
            firstProgressAtMs: progress ? 1 : null,
            lastObservedProgressSec: progress ? 73.5 : 0,
        };
    });
    const helpers = helpersHook.usePlaybackRecoveryHelpers({ refs });
    const recovery = hook.useServerMusicSourceRecovery({
        refs,
        currentTrack: selected,
        playbackType: "track",
        isPlaying: playing,
        playbackRecoveryHelpers: helpers,
        setCurrentTime: (value) => {
            savedPosition = value;
        },
        setIsBuffering: () => {},
        applyCurrentOutputState: () => {},
        releasePlaybackSource: () => {},
        getPlaybackSourceUrl: () => playbackSourceUrl,
    });
    React.useLayoutEffect(() => {
        attempt = recovery;
        recoveryHoldsEvents = () =>
            refs.serverSourceRecoveryLoadIdRef.current !== null;
    });
    return null;
}
async function mount() {
    hook =
        await import("../../components/player/hooks/useServerMusicSourceRecovery");
    refsHook =
        await import("../../components/player/hooks/usePlaybackOrchestratorRefs");
    helpersHook =
        await import("../../components/player/hooks/usePlaybackRecoveryHelpers");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = async () => {
        await React.act(async () => {
            root.render(React.createElement(Probe));
        });
    };
    await render();
    return {
        render,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}
beforeEach(() => {
    selected = track;
    playing = true;
    progress = true;
    listenTogether = false;
    savedPosition = 0;
    playbackSourceUrl = "/api/ytmusic/stream/original001";
    actions.length = 0;
    listeners.clear();
    request.mock.resetCalls();
});
after(() => GlobalRegistrator.unregister());
const path = `/api/music-sources/leases/${"a".repeat(48)}/stream`;
test("a downloaded YouTube recording cannot be stopped or replaced by server recovery", async () => {
    playbackSourceUrl = "blob:https://soundspan.test/downloaded";
    const view = await mount();
    try {
        const outcome = attempt(failed);
        await React.act(async () => {
            await Promise.resolve();
        });
        assert.equal(request.mock.callCount(), 0);
        assert.deepEqual(actions, []);
        assert.equal(await outcome, "not_applicable");
    } finally {
        await view.unmount();
    }
});
test("a played YouTube track recovers through a server source at the same position without changing its queue identity", async () => {
    const view = await mount();
    const pending = attempt(failed);
    await React.act(async () => {
        await Promise.resolve();
    });
    resolveRequest(path);
    await React.act(async () => {
        await Promise.resolve();
    });
    for (const cb of listeners.get("load") ?? []) cb({ durationSec: 240 });
    assert.equal(await pending, "recovered");
    assert.equal(savedPosition, 73.5);
    assert.equal(selected, track);
    assert.deepEqual(
        actions.filter((a) => a[0] === "seek" || a[0] === "play"),
        [["seek", 73.5], ["play"]],
    );
    assert.equal(await attempt(failed), "exhausted");
    assert.equal(request.mock.callCount(), 1);
    await view.unmount();
});
test("pause aborts a pending resolution and its late result cannot restart playback", async () => {
    const view = await mount();
    const pending = attempt(failed);
    playing = false;
    await view.render();
    assert.equal(await pending, "stale");
    assert.equal(requestSignal?.aborted, true);
    resolveRequest(path);
    await Promise.resolve();
    assert.equal(
        actions.some((a) => a[0] === "load" || a[0] === "play"),
        false,
    );
    await view.unmount();
});
test("selection of another queue entry cancels the old recovery", async () => {
    const view = await mount();
    const pending = attempt(failed);
    selected = { ...track, playlistItemId: "entry-2" };
    await view.render();
    resolveRequest(path);
    assert.equal(await pending, "stale");
    assert.equal(
        actions.some((a) => a[0] === "load"),
        false,
    );
    await view.unmount();
});

test("session revocation releases the old event guard without applying a late source", async () => {
    const view = await mount();
    const pending = attempt(failed);
    await Promise.resolve();
    assert.equal(recoveryHoldsEvents(), true);
    advanceAuthRuntimeGeneration();
    assert.equal(await pending, "stale");
    assert.equal(recoveryHoldsEvents(), false);
    resolveRequest(path);
    await Promise.resolve();
    assert.equal(
        actions.some((a) => a[0] === "load" || a[0] === "play"),
        false,
    );
    await view.unmount();
});
test("startup without confirmed progress and Listen Together do not start independent replacement", async () => {
    progress = false;
    const view = await mount();
    assert.equal(await attempt(failed), "not_applicable");
    progress = true;
    listenTogether = true;
    await view.render();
    assert.equal(await attempt(failed), "not_applicable");
    assert.equal(request.mock.callCount(), 0);
    await view.unmount();
});
test("a user seek during source resolution becomes the replacement position", async () => {
    const view = await mount();
    const pending = attempt(failed);
    await React.act(async () => {
        await Promise.resolve();
    });
    audioSeekEmitter.emit(120);
    resolveRequest(path);
    await React.act(async () => {
        await Promise.resolve();
    });
    for (const cb of listeners.get("load") ?? []) cb({ durationSec: 240 });
    assert.equal(await pending, "recovered");
    assert.equal(savedPosition, 120);
    assert.deepEqual(
        actions.filter((a) => a[0] === "seek" || a[0] === "play"),
        [["seek", 120], ["play"]],
    );
    await view.unmount();
});
