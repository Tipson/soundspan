import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Track } from "../../lib/audio-state-context";
import type { PlaybackOrchestratorRefs } from "../../components/player/hooks/usePlaybackOrchestratorRefs";
import type {
    AudioControlsContextType,
    VibeModeStartOptions,
    VibeModeStartResult,
} from "../../lib/audio-controls-types";
import {
    recordExplicitPlaybackPause,
    recordExplicitPlaybackResume,
} from "../../lib/audio-engine/playbackAdvanceOrigin";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let group: { groupId: string; isHost: boolean } | null = null;
let audioState: Record<string, unknown> = {};
let playbackState: Record<string, unknown> = {};
let startManualVibe: (
    options?: VibeModeStartOptions,
) => Promise<VibeModeStartResult> = async () => ({
    success: false,
    trackCount: 0,
});
mock.module("@/lib/listen-together-session", {
    namedExports: {
        getListenTogetherSessionSnapshot: () => group,
        enqueueLatestListenTogetherHostTrackOperation: () => undefined,
        getListenTogetherOptimisticTrackSelectionPolicy: () => ({
            resetPersistedTrackStartPosition: false,
        }),
    },
});
mock.module("@/lib/listen-together-socket", {
    namedExports: {
        listenTogetherSocket: {
            get hasActiveGroup() {
                return Boolean(group);
            },
            get activeGroupId() {
                return group?.groupId ?? null;
            },
        },
    },
});
mock.module("@/lib/audio-state-context", {
    namedExports: { useAudioState: () => audioState },
});
mock.module("@/lib/audio-playback-context", {
    namedExports: {
        usePlaybackStatus: () => playbackState,
        usePlaybackProgress: () => playbackState,
    },
});
mock.module("@/lib/audio-volume-mode-context", {
    namedExports: {
        useAudioVolumeMode: () => ({
            volume: 1,
            isMuted: false,
            playerMode: "full",
            previousPlayerMode: "full",
            setVolume() {},
            setIsMuted() {},
            setPlayerMode() {},
            setPreviousPlayerMode() {},
        }),
    },
});
mock.module("@/lib/audio/useVibeModeControls", {
    namedExports: {
        useVibeModeControls: () => ({
            startVibeMode: (options?: VibeModeStartOptions) =>
                startManualVibe(options),
            stopVibeMode() {},
        }),
    },
});
mock.module("@/lib/query-events", {
    namedExports: { dispatchQueryEvent() {} },
});
mock.module("sonner", {
    namedExports: { toast: { success() {}, error() {}, info() {} } },
});
mock.module("@/lib/api", { namedExports: { api: {} } });
mock.module("@/lib/logger", {
    namedExports: { frontendLogger: { error: () => undefined } },
});
mock.module("@/lib/audio-engine/audioPlaybackOrchestratorRuntime", {
    namedExports: { logPlaybackClientMetric: () => undefined },
});
let useAutoMatchVibe: typeof import("../../components/player/hooks/usePlaybackAccounts").useAutoMatchVibe;
let useQueueRecoveryEffects: typeof import("../../components/player/hooks/useQueueRecoveryEffects").useQueueRecoveryEffects;
before(async () => {
    ({ useAutoMatchVibe } =
        await import("../../components/player/hooks/usePlaybackAccounts"));
    ({ useQueueRecoveryEffects } =
        await import("../../components/player/hooks/useQueueRecoveryEffects"));
});
after(async () => GlobalRegistrator.unregister());
beforeEach(() => {
    group = null;
    recordExplicitPlaybackResume();
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function mountHook<P, T>(hook: (options: P) => T, initial: P) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let value!: T;
    function Probe({ options }: { options: P }) {
        value = hook(options);
        return null;
    }
    const render = async (options: P) =>
        React.act(async () => {
            root.render(React.createElement(Probe, { options }));
        });
    await render(initial);
    return {
        get current() {
            return value;
        },
        render,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

const originA = {
    kind: "artist" as const,
    source: "library" as const,
    id: "artist-a",
};
const originB = {
    kind: "artist" as const,
    source: "discovery" as const,
    name: "Artist B",
};
const seed: Track = {
    id: "same-library-song",
    title: "Song",
    duration: 180,
    artist: { id: "artist-current", name: "Current artist" },
    album: { id: "album", title: "Album" },
    radioOrigin: originA,
};
function refsFor(track = seed) {
    return {
        autoMatchVibePromiseRef: { current: null },
        autoMatchVibeTrackIdRef: { current: null },
        autoMatchVibeLastAttemptAtRef: { current: 0 },
        pendingAutoMatchAdvanceRef: { current: null },
        pendingTrackErrorTrackIdRef: { current: null },
        advancePlayIntentAtMsRef: { current: 0 },
        currentTrackRef: { current: track },
        loadIdRef: { current: 1 },
        seekOperationIdRef: { current: 0 },
    } as unknown as PlaybackOrchestratorRefs;
}

for (const replacement of [originB, undefined]) {
    test(`same-ID ${replacement ? "changed" : "cleared"} radio origin owns a fresh AutoMatch request`, async (t) => {
        const refs = refsFor();
        const responses: ReturnType<typeof deferred<VibeModeStartResult>>[] =
            [];
        const startVibeMode = () => {
            const response = deferred<VibeModeStartResult>();
            responses.push(response);
            return response.promise;
        };
        const options = {
            refs,
            startVibeMode,
            radioOrigin: originA as Track["radioOrigin"],
        };
        const probe = await mountHook(useAutoMatchVibe, options);
        t.after(probe.unmount);
        const old = probe.current(seed.id);
        await probe.render({ ...options, radioOrigin: replacement });
        const current = probe.current(seed.id);
        assert.equal(responses.length, 2);
        assert.notEqual(current, old);
        responses[0].resolve({ success: false, trackCount: 0 });
        await old;
        assert.equal(
            refs.autoMatchVibePromiseRef.current,
            current,
            "old finalization cannot clear the replacement",
        );
        responses[1].resolve({ success: false, trackCount: 0 });
        await current;
    });
}

test("equal normalized radio origin coalesces and retains the existing cooldown", async (t) => {
    const refs = refsFor(),
        response = deferred<VibeModeStartResult>();
    let calls = 0;
    const options = {
        refs,
        radioOrigin: originA,
        startVibeMode: () => {
            calls++;
            return response.promise;
        },
    };
    const probe = await mountHook(useAutoMatchVibe, options);
    t.after(probe.unmount);
    const first = probe.current(seed.id);
    await probe.render({
        ...options,
        radioOrigin: { id: " artist-a ", source: "library", kind: "artist" },
    });
    assert.equal(probe.current(seed.id), first);
    response.resolve({ success: false, trackCount: 0 });
    await first;
    await probe.current(seed.id);
    assert.equal(calls, 1);
});

test("changed same-ID station bypasses only the previous station cooldown", async (t) => {
    const refs = refsFor();
    let calls = 0;
    const options = {
        refs,
        radioOrigin: originA as Track["radioOrigin"],
        startVibeMode: async () => {
            calls++;
            return { success: false, trackCount: 0 };
        },
    };
    const probe = await mountHook(useAutoMatchVibe, options);
    t.after(probe.unmount);
    await probe.current(seed.id);
    await probe.render({ ...options, radioOrigin: originB });
    await probe.current(seed.id);
    assert.equal(calls, 2);
});

for (const transition of ["origin", "clear-origin", "group"] as const) {
    for (const success of [false, true]) {
        test(`late ${success ? "successful" : "failed"} tail response cannot advance after ${transition}`, async (t) => {
            const refs = refsFor();
            const response = deferred<
                | { didExtendQueue: false; queueMutation: null }
                | { didExtendQueue: true; queueMutation: "append" }
            >();
            let advances = 0;
            const options = {
                refs,
                playbackType: "track" as const,
                queue: [seed],
                queueLength: 1,
                currentIndex: 0,
                isShuffle: false,
                shuffleIndices: [],
                repeatMode: "off" as const,
                currentTrack: seed,
                requestAutoMatchVibe: () => response.promise,
                advanceQueue: () => {
                    advances++;
                },
                clearPendingTrackErrorSkip() {},
                clearStartupPlaybackRecovery() {},
                clearTransientTrackRecovery() {},
            };
            const probe = await mountHook(useQueueRecoveryEffects, options);
            t.after(probe.unmount);
            assert.equal(probe.current(false), true);
            if (transition === "group")
                group = { groupId: "joined", isHost: true };
            else
                refs.currentTrackRef.current = {
                    ...seed,
                    radioOrigin: transition === "origin" ? originB : undefined,
                };
            await probe.render({
                ...options,
                currentTrack: refs.currentTrackRef.current!,
            });
            if (success)
                await probe.render({
                    ...options,
                    currentTrack: refs.currentTrackRef.current!,
                    queue: [seed, { ...seed, id: "next" }],
                    queueLength: 2,
                });
            await React.act(async () => {
                response.resolve(
                    success
                        ? { didExtendQueue: true, queueMutation: "append" }
                        : { didExtendQueue: false, queueMutation: null },
                );
                await response.promise;
            });
            assert.equal(advances, 0);
            assert.equal(refs.pendingAutoMatchAdvanceRef.current, null);
        });
    }
}

for (const transition of [
    "equivalent-origin",
    "pause",
    "occurrence",
] as const) {
    test(`existing tail pending guard preserves ${transition}`, async (t) => {
        const refs = refsFor(),
            response = deferred<{
                didExtendQueue: false;
                queueMutation: null;
            }>();
        let advances = 0;
        const options = {
            refs,
            playbackType: "track" as const,
            queue: [seed],
            queueLength: 1,
            currentIndex: 0,
            isShuffle: false,
            shuffleIndices: [],
            repeatMode: "off" as const,
            currentTrack: seed,
            requestAutoMatchVibe: () => response.promise,
            advanceQueue: () => {
                advances++;
            },
            clearPendingTrackErrorSkip() {},
            clearStartupPlaybackRecovery() {},
            clearTransientTrackRecovery() {},
        };
        const probe = await mountHook(useQueueRecoveryEffects, options);
        t.after(probe.unmount);
        assert.equal(probe.current(false), true);
        if (transition === "pause") recordExplicitPlaybackPause();
        if (transition === "equivalent-origin")
            refs.currentTrackRef.current = {
                ...seed,
                radioOrigin: {
                    id: " artist-a ",
                    kind: "artist",
                    source: "library",
                },
            };
        await probe.render({
            ...options,
            currentTrack: refs.currentTrackRef.current!,
            queue: transition === "occurrence" ? [{ ...seed }] : options.queue,
        });
        await React.act(async () => {
            response.resolve({ didExtendQueue: false, queueMutation: null });
            await response.promise;
        });
        assert.equal(advances, transition === "equivalent-origin" ? 1 : 0);
    });
}

test("a committed origin replacement fences advance before the shared track ref catches up", async (t) => {
    const refs = refsFor(),
        response = deferred<{ didExtendQueue: false; queueMutation: null }>();
    let advances = 0;
    const options = {
        refs,
        playbackType: "track" as const,
        queue: [seed],
        queueLength: 1,
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "off" as const,
        currentTrack: seed,
        requestAutoMatchVibe: () => response.promise,
        advanceQueue: () => {
            advances++;
        },
        clearPendingTrackErrorSkip() {},
        clearStartupPlaybackRecovery() {},
        clearTransientTrackRecovery() {},
    };
    const probe = await mountHook(useQueueRecoveryEffects, options);
    t.after(probe.unmount);
    assert.equal(probe.current(false), true);
    // usePlaybackStateSync updates this shared ref in a passive effect.
    // The latest committed props already carry the replacement origin.
    await probe.render({
        ...options,
        currentTrack: { ...seed, radioOrigin: originB },
    });
    assert.equal(refs.currentTrackRef.current, seed);
    await React.act(async () => {
        response.resolve({ didExtendQueue: false, queueMutation: null });
        await response.promise;
    });
    assert.equal(advances, 0);
});

test("a fresh end at the replacement station owns its own pending advance", async (t) => {
    const refs = refsFor(),
        response = deferred<{ didExtendQueue: false; queueMutation: null }>();
    let advances = 0;
    const options = {
        refs,
        playbackType: "track" as const,
        queue: [seed],
        queueLength: 1,
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "off" as const,
        currentTrack: seed,
        requestAutoMatchVibe: () => response.promise,
        advanceQueue: () => {
            advances++;
        },
        clearPendingTrackErrorSkip() {},
        clearStartupPlaybackRecovery() {},
        clearTransientTrackRecovery() {},
    };
    const probe = await mountHook(useQueueRecoveryEffects, options);
    t.after(probe.unmount);
    refs.currentTrackRef.current = { ...seed, radioOrigin: originB };
    await probe.render({
        ...options,
        currentTrack: refs.currentTrackRef.current,
    });
    assert.equal(probe.current(false), true);
    await React.act(async () => {
        response.resolve({ didExtendQueue: false, queueMutation: null });
        await response.promise;
    });
    assert.equal(advances, 1);
});

async function mountManualControls(currentTrack: Track) {
    const { AudioControlsProvider, useAudioControls } =
        await import("../../lib/audio-controls-context");
    const pending: Array<() => void> = [];
    const state: Record<string, unknown> = {
        currentTrack,
        currentIndex: 0,
        queue: [currentTrack],
        playbackType: "track",
        currentPodcast: null,
        currentAudiobook: null,
        repeatMode: "off",
        repeatOneCount: 0,
        isShuffle: false,
        shuffleIndices: [],
        vibeMode: false,
        waveMode: "for-you",
        waveMood: null,
        vibeQueueIds: [],
        vibeSourceFeatures: null,
    };
    for (const key of [
        "queue",
        "currentIndex",
        "currentTrack",
        "currentPodcast",
        "currentAudiobook",
        "playbackType",
        "shuffleIndices",
        "isShuffle",
        "repeatMode",
        "repeatOneCount",
        "vibeMode",
        "vibeQueueIds",
        "vibeSourceFeatures",
    ]) {
        state[`set${key[0].toUpperCase()}${key.slice(1)}`] = (value: unknown) =>
            pending.push(() => {
                state[key] =
                    typeof value === "function"
                        ? (value as (previous: unknown) => unknown)(state[key])
                        : value;
            });
    }
    const playback = {
        currentTime: 37,
        duration: 180,
        isPlaying: true,
        setIsPlaying(value: boolean) {
            this.isPlaying = value;
        },
        setCurrentTime(value: number) {
            this.currentTime = value;
        },
        lockSeek() {},
    };
    audioState = state;
    playbackState = playback;
    let controls!: AudioControlsContextType;
    function Probe() {
        controls = useAudioControls();
        return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = async () =>
        React.act(async () => {
            root.render(
                React.createElement(
                    AudioControlsProvider,
                    null,
                    React.createElement(Probe),
                ),
            );
        });
    const commit = () => {
        while (pending.length) pending.shift()!();
    };
    await render();
    return {
        state,
        playback,
        get controls() {
            return controls;
        },
        commit,
        render,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("manual Next at artist radio tail refills once without enabling Vibe or restarting current audio", async (t) => {
    const response = deferred<VibeModeStartResult>();
    const requests: Array<VibeModeStartOptions | undefined> = [];
    startManualVibe = (options) => {
        requests.push(options);
        return response.promise;
    };
    const probe = await mountManualControls(seed);
    t.after(probe.unmount);
    await React.act(async () => {
        probe.controls.next();
        probe.controls.next();
    });
    assert.equal(requests.length, 1);
    assert.equal(probe.state.vibeMode, false);
    assert.equal(probe.state.currentIndex, 0);
    assert.equal(probe.playback.currentTime, 37);
    assert.equal(probe.playback.isPlaying, true);
    const next = { ...seed, id: "next-radio-song" };
    await React.act(async () => {
        (probe.state.setQueue as (value: unknown) => void)([seed, next]);
        requests[0]?.onLocalQueueCommit?.({
            token: requests[0].queueCommitToken!,
            mutation: "append",
        });
        probe.commit();
        response.resolve({ success: true, trackCount: 1 });
        await response.promise;
    });
    await probe.render();
    probe.commit();
    assert.equal(probe.state.currentIndex, 1);
    assert.equal((probe.state.currentTrack as Track).id, next.id);
    assert.equal(probe.state.vibeMode, false);
});

for (const transition of ["origin", "group", "pause"] as const) {
    test(`manual radio tail rejects a late successful refill after ${transition}`, async (t) => {
        const response = deferred<VibeModeStartResult>();
        let request: VibeModeStartOptions | undefined;
        startManualVibe = (options) => {
            request = options;
            return response.promise;
        };
        const probe = await mountManualControls(seed);
        t.after(probe.unmount);
        await React.act(async () => probe.controls.next());
        assert.ok(request?.queueCommitToken);
        if (transition === "origin")
            probe.state.currentTrack = { ...seed, radioOrigin: originB };
        if (transition === "group") group = { groupId: "joined", isHost: true };
        if (transition === "pause") recordExplicitPlaybackPause();
        await probe.render();
        await React.act(async () => {
            (probe.state.setQueue as (value: unknown) => void)([
                seed,
                { ...seed, id: "late-radio-song" },
            ]);
            request?.onLocalQueueCommit?.({
                token: request.queueCommitToken!,
                mutation: "append",
            });
            probe.commit();
            response.resolve({ success: true, trackCount: 1 });
            await response.promise;
        });
        await probe.render();
        probe.commit();
        assert.equal(probe.state.currentIndex, 0);
        assert.equal(probe.playback.currentTime, 37);
        assert.equal(probe.playback.isPlaying, true);
    });
}
