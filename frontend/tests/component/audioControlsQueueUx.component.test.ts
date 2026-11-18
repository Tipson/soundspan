import {
    getCollectionPlaybackGeneration,
    isCollectionPlayback,
    markCollectionPlayback,
} from "../../lib/collectionPlayback";
import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Track } from "../../lib/audio-state-context";
import type { QueueItem } from "../../lib/queue-item";
import { readFileSync } from "node:fs";
import {
    readOrderedWavePage,
    orderedWaveQueueCheckpoints,
} from "../../lib/audio/orderedWaveSequence";
import { toProviderPlaybackTrack } from "../../lib/audio/providerRadioContinuation";
import { getRecommendationSessionId } from "../../lib/recommendationSession";
import {
    RecommendationQueueFeedback,
    recommendationScopeForTrack,
} from "../../lib/audio/recommendationQueueFeedback";
import { registerRecommendationFeedbackOwner } from "../../lib/audio/recommendationFeedbackBridge";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Episode } from "../../features/podcast/types";
import type { PlayEngagementInput, PlayLogInput } from "../../lib/api/plays";
import { installPlayCreateJournalBridge } from "../../lib/playCreateJournalBridge";
import { getAuthRuntimeLease } from "../../lib/auth-runtime-generation";
import { createConsecutiveErrorBreaker } from "../../lib/audio-engine/consecutiveErrorBreaker";
import {
    consumePlaybackAdvanceOrigin,
    getExplicitPlaybackPauseGeneration,
    playbackAdvanceOriginRef,
    setPlaybackAutoRestartSuppressed,
} from "../../lib/audio-engine/playbackAdvanceOrigin";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
window.confirm = () => true;

/**
 * Behavior tests for the mixed-queue UX fixes in
 * lib/audio-controls-context.tsx (PR #2 follow-ups):
 *
 *  1. removeFromQueue of the playing LAST item persists the outgoing
 *     episode's progress and routes the new current item through the
 *     shared startQueueItemAtIndex resume path.
 *  2. addTracksToQueue's legacy-state seed (episode playing, empty queue)
 *     seeds a real shuffle order instead of identity indices.
 *  3. addEpisodeToQueue (and the addTracksToQueue append) compute appended
 *     shuffle indices inside the functional updater, so rapid adds never
 *     stamp the same index twice.
 *  4. Skipping into an episode advances currentIndex immediately, so a
 *     second next() during the saved-progress lookup window skips past it.
 *
 * The audio state stub models React's state batching: setter calls are
 * queued and only applied by `commit()`, which stands in for a re-render
 * between user interactions. Calls made without an intervening commit
 * therefore observe the same committed snapshot, exactly like two calls
 * within one render.
 */

const stateHolder: { current: Record<string, unknown> } = { current: {} };
const playbackHolder: { current: Record<string, unknown> } = { current: {} };
let apiSessionGeneration = 0;
const apiCalls: {
    updatePodcastProgress: unknown[][];
    personalizedRequests: string[];
} = {
    updatePodcastProgress: [],
    personalizedRequests: [],
};
const getPodcastImpl: { current: (id: string) => Promise<unknown> } = {
    current: async () => ({ episodes: [] }),
};
const personalizedFeed = {
    current: {
        shelves: { listenAgain: [], quickPicks: [], discovery: [] },
        degraded: false,
        reason: null,
        seedCount: 1,
    } as Record<string, unknown>,
};
const personalizedFeedGate: { current: Promise<void> | null } = {
    current: null,
};
const personalizedRequestImpl: {
    current: (() => Promise<unknown>) | null;
} = { current: null };
const engagementWriteImpl: {
    current:
        | ((playId: string, input: PlayEngagementInput) => Promise<unknown>)
        | null;
} = { current: null };
const playCreateImpl: {
    current: ((input: PlayLogInput) => Promise<{ id: string }>) | null;
} = { current: null };
const listenTogetherSession = {
    current: null as {
        groupId: string;
        isHost: boolean;
        playback: {
            isPlaying: boolean;
            positionMs: number;
            serverTime: number;
            currentIndex: number;
        };
    } | null,
};
const listenTogetherQueueCalls: unknown[][] = [];
let unregisterFeedback = () => {};
const listenTogetherSocketMock = {
    hasActiveGroup: false,
    activeGroupId: null as string | null,
    addToQueue: async (tracks: unknown[]) => {
        listenTogetherQueueCalls.push(tracks);
        return {
            acceptedCount: tracks.length,
            skippedCount: 0,
            truncated: false,
        };
    },
};

afterEach(() => {
    unregisterFeedback();
    personalizedFeedGate.current = null;
    personalizedRequestImpl.current = null;
    engagementWriteImpl.current = null;
    playCreateImpl.current = null;
    apiSessionGeneration = 0;
    playbackAdvanceOriginRef.current = null;
    setPlaybackAutoRestartSuppressed(false);
    listenTogetherSession.current = null;
    listenTogetherSocketMock.hasActiveGroup = false;
    listenTogetherSocketMock.activeGroupId = null;
    listenTogetherQueueCalls.length = 0;
});

after(async () => {
    await GlobalRegistrator.unregister();
});

mock.module("@/lib/audio-volume-mode-context", {
    namedExports: {
        useAudioVolumeMode: () => ({
            volume: 1,
            isMuted: false,
            playerMode: "full",
            previousPlayerMode: "full",
            setVolume: () => undefined,
            setIsMuted: () => undefined,
            setPlayerMode: () => undefined,
            setPreviousPlayerMode: () => undefined,
        }),
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: { useAudioState: () => stateHolder.current },
});
mock.module("@/lib/audio-playback-context", {
    namedExports: {
        useAudioPlayback: () => playbackHolder.current,
        usePlaybackStatus: () => playbackHolder.current,
        usePlaybackProgress: () => playbackHolder.current,
    },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getSessionGeneration: () => apiSessionGeneration,
            updatePodcastProgress: (...args: unknown[]) => {
                apiCalls.updatePodcastProgress.push(args);
                return Promise.resolve({});
            },
            getPodcast: (id: string) => getPodcastImpl.current(id),
            clearPlaybackState: async () => ({}),
            logPlay: async (track: PlayLogInput) =>
                playCreateImpl.current?.(track) ?? {
                    id: `play-${"youtubeVideoId" in track ? track.youtubeVideoId : "other"}`,
                },
            updatePlayEngagement: async (
                playId: string,
                input: PlayEngagementInput,
            ) =>
                engagementWriteImpl.current?.(playId, input) ?? {
                    success: true,
                },
            request: async (path: string) => {
                apiCalls.personalizedRequests.push(path);
                if (personalizedRequestImpl.current)
                    return personalizedRequestImpl.current();
                if (personalizedFeedGate.current)
                    await personalizedFeedGate.current;
                return personalizedFeed.current;
            },
        },
    },
});
mock.module("@/lib/listen-together-socket", {
    namedExports: {
        listenTogetherSocket: listenTogetherSocketMock,
    },
});
mock.module("@/lib/listen-together-session", {
    namedExports: {
        enqueueLatestListenTogetherHostTrackOperation: () => undefined,
        getListenTogetherOptimisticTrackSelectionPolicy: () => ({
            resetPersistedTrackStartPosition: false,
        }),
        getListenTogetherSessionSnapshot: () => listenTogetherSession.current,
        isListenTogetherActiveOrPending: () =>
            Boolean(listenTogetherSession.current),
    },
});
mock.module("sonner", {
    namedExports: {
        toast: {
            success: () => undefined,
            error: () => undefined,
            info: () => undefined,
        },
    },
});
mock.module("@/lib/query-events", {
    namedExports: { dispatchQueryEvent: () => undefined },
});

type DeferredAudioState = Record<string, unknown> & {
    commit: () => void;
    feedback: RecommendationQueueFeedback;
};

function createDeferredAudioState(
    initial: Record<string, unknown>,
): DeferredAudioState {
    const pending: Array<() => void> = [];
    const feedback = new RecommendationQueueFeedback();
    const stub: DeferredAudioState = {
        feedback,
        recommendationFeedback: {
            allows: (track: QueueItem) =>
                Boolean(listenTogetherSession.current) ||
                feedback.allows(track),
            reset: feedback.reset.bind(feedback),
            pruneFuture: (queue: Parameters<typeof feedback.pruneFuture>[0]) =>
                listenTogetherSession.current
                    ? queue
                    : feedback.pruneFuture(queue),
            revision: 0,
        },
        currentTrack: null,
        localTrackPlaybackOccurrence: 0,
        commitLocalTrackPlaybackOccurrence: () => {
            if (listenTogetherSession.current) return;
            pending.push(() => {
                stub.localTrackPlaybackOccurrence =
                    (stub.localTrackPlaybackOccurrence as number) + 1;
            });
        },
        currentPodcast: null,
        currentAudiobook: null,
        playbackType: null,
        queue: [],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "off",
        repeatOneCount: 0,
        vibeMode: false,
        waveMode: "for-you",
        waveMood: null,
        vibeSourceFeatures: null,
        vibeQueueIds: [],
        playerMode: "full",
        previousPlayerMode: "full",
        volume: 1,
        isMuted: false,
        ...initial,
        commit: () => {
            while (pending.length > 0) {
                (pending.shift() as () => void)();
            }
            if (!listenTogetherSession.current) {
                const pruned = feedback.pruneFuture({
                    queue: stub.queue as QueueItem[],
                    currentIndex: stub.currentIndex as number,
                    isShuffle: stub.isShuffle as boolean,
                    shuffleIndices: stub.shuffleIndices as number[],
                });
                stub.queue = pruned.queue;
                stub.currentIndex = pruned.currentIndex;
                stub.shuffleIndices = pruned.shuffleIndices;
            }
        },
    };

    const settableKeys = [
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
        "vibeSourceFeatures",
        "vibeQueueIds",
        "playerMode",
        "previousPlayerMode",
        "volume",
        "isMuted",
    ];
    for (const key of settableKeys) {
        const setterName = `set${key.charAt(0).toUpperCase()}${key.slice(1)}`;
        stub[setterName] = (value: unknown) => {
            pending.push(() => {
                stub[key] =
                    typeof value === "function"
                        ? (value as (prev: unknown) => unknown)(stub[key])
                        : value;
            });
        };
    }
    return stub;
}

function createPlaybackStub(
    initial: { currentTime?: number; duration?: number } = {},
) {
    return {
        currentTime: initial.currentTime ?? 0,
        duration: initial.duration ?? 0,
        isPlaying: false,
        setIsPlaying(value: boolean) {
            this.isPlaying = value;
        },
        setCurrentTime(value: number) {
            this.currentTime = value;
        },
        lockSeek: () => undefined,
    };
}

async function renderControls(options: {
    state: DeferredAudioState;
    playback: Record<string, unknown>;
}) {
    stateHolder.current = options.state;
    unregisterFeedback();
    unregisterFeedback = registerRecommendationFeedbackOwner({
        begin: (trackId, signal) => {
            const track = options.state.currentTrack as Track | null;
            return listenTogetherSession.current
                ? null
                : options.state.feedback.begin({
                      trackId,
                      signal,
                      scope: track ? recommendationScopeForTrack(track) : null,
                  });
        },
        reconcile: options.state.feedback.reconcile.bind(
            options.state.feedback,
        ),
        reportFailure: () => assert.fail("Unexpected feedback queue failure"),
    });
    playbackHolder.current = options.playback;
    apiCalls.updatePodcastProgress.length = 0;
    apiCalls.personalizedRequests.length = 0;

    const { AudioControlsProvider, useAudioControls } =
        await import("../../lib/audio-controls-context");

    const capturedRef: {
        current: ReturnType<typeof useAudioControls> | null;
    } = { current: null };
    const Probe = () => {
        capturedRef.current = useAudioControls();
        return React.createElement("div", null, "controls-ready");
    };
    const html = renderToStaticMarkup(
        React.createElement(
            AudioControlsProvider,
            null,
            React.createElement(Probe),
        ),
    );
    assert.ok(html.includes("controls-ready"));
    assert.ok(capturedRef.current);
    return capturedRef.current;
}

const flushAsync = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
};

const currentTrackId = (state: DeferredAudioState) =>
    (state.currentTrack as Track | null)?.id;

test("clearing a personal Wave then starting its cached prefix advances beyond the cleared recording", async (t) => {
    const tracks = [
        makeTrack("wave-a", "a"),
        makeTrack("wave-b", "b"),
        makeTrack("wave-c", "c"),
    ];
    const state = createDeferredAudioState({
        queue: tracks,
        currentIndex: 0,
        currentTrack: tracks[0],
        playbackType: "track",
        vibeMode: true,
        vibeQueueIds: tracks.map((row) => row.id),
    });
    const playback = createPlaybackStub({ currentTime: 7, duration: 200 });
    playback.isPlaying = true;
    stateHolder.current = state;
    playbackHolder.current = playback;
    const { AudioControlsProvider, useAudioControls } =
        await import("../../lib/audio-controls-context");
    const { createRoot } = await import("react-dom/client");
    let controls!: ReturnType<typeof useAudioControls>;
    function Probe() {
        controls = useAudioControls();
        return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => {
        await React.act(async () => root.unmount());
        container.remove();
    });
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
    await render();
    await React.act(async () => {
        controls.clearQueue();
        state.commit();
    });
    await render();
    assert.equal(state.currentTrack, null);
    assert.deepEqual(state.queue, []);
    assert.equal(playback.isPlaying, false);
    assert.equal(
        state.localTrackPlaybackOccurrence,
        0,
        "clear is not a new Play or dislike/history observation",
    );
    await React.act(async () => {
        controls.playTracks(tracks, 0, true);
        state.commit();
    });
    await render();
    assert.equal(currentTrackId(state), "wave-b");
    assert.equal(state.currentIndex, 1);
    assert.deepEqual(
        (state.queue as Track[]).map((row) => row.id),
        tracks.map((row) => row.id),
        "server order is preserved",
    );
    assert.equal(state.localTrackPlaybackOccurrence, 1);
    assert.equal(playback.isPlaying, true);
});

async function clearedWaveFixture(
    t: { after: (fn: () => Promise<void>) => void },
    currentIndex = 2,
    beforeClear?: (tracks: Track[]) => void,
) {
    apiCalls.personalizedRequests.length = 0;
    const tracks = [
        makeTrack("wave-a", "a"),
        makeTrack("wave-b", "b"),
        makeTrack("wave-c", "c"),
    ];
    const state = createDeferredAudioState({
        queue: tracks,
        currentIndex,
        currentTrack: tracks[currentIndex],
        playbackType: "track",
        vibeMode: true,
        waveLanguage: "any",
    });
    const playback = createPlaybackStub();
    playback.isPlaying = true;
    stateHolder.current = state;
    playbackHolder.current = playback;
    const { AudioControlsProvider, useAudioControls } =
        await import("../../lib/audio-controls-context");
    const { createRoot } = await import("react-dom/client");
    let controls!: ReturnType<typeof useAudioControls>;
    function Probe() {
        controls = useAudioControls();
        return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => {
        await React.act(async () => root.unmount());
        container.remove();
    });
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
    await render();
    beforeClear?.(tracks);
    await React.act(async () => {
        controls.clearQueue();
        state.commit();
    });
    await render();
    return {
        tracks,
        state,
        playback,
        render,
        controls: () => controls,
        flush: async () => {
            await React.act(async () => {
                await flushAsync();
                state.commit();
            });
            await render();
        },
    };
}

function restartFeed(ids: string[]) {
    return {
        generationId: "restart-generation",
        shelves: {
            listenAgain: [],
            quickPicks: [],
            discovery: ids.map((id) => ({
                ...makeTrack(id, id),
                source: "library",
                provider: {},
            })),
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    };
}

test("cleared Wave ordered tail retains the opaque continuation and its exact history tail", async (t) => {
    const owner = {
        authGeneration: apiSessionGeneration,
        sessionId: getRecommendationSessionId(),
        intent: JSON.stringify(["for-you", null, "any"]),
    };
    const page = (ids: string[], start: number, tailIds: string[]) =>
        readOrderedWavePage({
            orderedWave: {
                version: 1,
                sequenceId: "5d73c623-d11d-4fda-943e-0e01ce5b3be7",
                startPosition: start,
                nextCursor: `cursor-${start + ids.length}`,
                items: ids.map((id, index) => ({
                    position: start + index,
                    track: {
                        ...makeTrack(id, id),
                        source: "library",
                        provider: {},
                        album: { ...makeTrack(id, id).album, coverArt: null },
                    },
                })),
                tail: tailIds.map((id, index) => ({
                    source: "library",
                    id,
                    position: start + ids.length - tailIds.length + index,
                })),
            },
        } as Parameters<typeof readOrderedWavePage>[0])!;
    const seed = page(["wave-a", "wave-b", "wave-c"], 0, ["wave-b", "wave-c"]);
    const next = page(["wave-fresh"], 3, ["wave-c", "wave-fresh"]);
    const fixture = await clearedWaveFixture(t, 2, (tracks) =>
        assert.equal(
            orderedWaveQueueCheckpoints.commit(tracks, seed, owner),
            true,
        ),
    );
    personalizedFeed.current = { ...restartFeed([]), orderedWave: next };
    fixture
        .controls()
        .playTracks(fixture.tracks, 0, true, {
            orderedWave: { page: seed, owner },
        });
    await fixture.flush();
    assert.equal(currentTrackId(fixture.state), "wave-fresh");
    assert.equal(fixture.state.currentIndex, 3);
    const checkpoint = orderedWaveQueueCheckpoints.capture(
        fixture.state.queue as Track[],
        owner,
    );
    assert.equal(checkpoint?.nextPosition, 4);
    assert.equal(checkpoint?.nextCursor, "cursor-4");
    assert.equal(
        new URL(
            apiCalls.personalizedRequests[0],
            "https://example.test",
        ).searchParams.get("waveSequenceCursor"),
        "cursor-3",
    );
});

test("cleared Wave tail requests continuation before playing a fresh recording", async (t) => {
    const fixture = await clearedWaveFixture(t);
    personalizedFeed.current = restartFeed(["wave-fresh"]);
    fixture.controls().playTracks(fixture.tracks, 0, true);
    assert.equal(fixture.state.currentTrack, null);
    await fixture.flush();
    assert.equal(currentTrackId(fixture.state), "wave-fresh");
    assert.equal(apiCalls.personalizedRequests.length, 1);
    const path = new URL(
        apiCalls.personalizedRequests[0],
        "https://example.test",
    );
    assert.equal(path.searchParams.get("cursor"), "3");
    assert.equal(path.searchParams.get("surface"), "wave");
    assert.equal(fixture.state.localTrackPlaybackOccurrence, 1);
});

test("cleared Wave one-recording fallback is bounded and asks again after the next Clear", async (t) => {
    const fixture = await clearedWaveFixture(t, 0);
    const only = [fixture.tracks[0]];
    personalizedFeed.current = restartFeed(["wave-a"]);
    fixture.controls().playTracks(only, 0, true);
    await fixture.flush();
    assert.equal((fixture.state.currentTrack as Track).id, "wave-a");
    assert.equal(apiCalls.personalizedRequests.length, 1);
    fixture.controls().clearQueue();
    fixture.state.commit();
    await fixture.render();
    fixture.controls().playTracks(only, 0, true);
    await fixture.flush();
    assert.equal(
        apiCalls.personalizedRequests.length,
        2,
        "the exhausted cached prefix is never reused forever without I/O",
    );
});

for (const action of [
    "pause",
    "manual",
    "clear",
    "owner",
    "direction",
] as const) {
    test(`cleared Wave late continuation cannot replace a newer ${action} intent`, async (t) => {
        const fixture = await clearedWaveFixture(t);
        let release!: (value: unknown) => void;
        personalizedRequestImpl.current = () =>
            new Promise((resolve) => {
                release = resolve;
            });
        fixture.controls().playTracks(fixture.tracks, 0, true);
        await fixture.flush();
        assert.equal(apiCalls.personalizedRequests.length, 1);
        if (action === "pause") fixture.controls().pause();
        if (action === "manual")
            fixture.controls().playTracks([makeTrack("manual", "m")]);
        if (action === "clear") fixture.controls().clearQueue();
        if (action === "owner") apiSessionGeneration++;
        if (action === "direction") fixture.state.waveMode = "new";
        fixture.state.commit();
        await fixture.render();
        release(restartFeed(["late-wave"]));
        await fixture.flush();
        assert.equal(
            (fixture.state.currentTrack as Track | null)?.id ?? null,
            action === "manual" ? "manual" : null,
        );
        assert.equal(fixture.playback.isPlaying, action === "manual");
    });
}

test("cleared Wave bookmark does not override explicit index, finite playlist or changed direction", async (t) => {
    for (const action of ["index", "finite", "direction", "owner"] as const) {
        const fixture = await clearedWaveFixture(t, 0);
        if (action === "direction") fixture.state.waveMode = "new";
        if (action === "owner") apiSessionGeneration++;
        await fixture.render();
        fixture
            .controls()
            .playTracks(
                fixture.tracks,
                action === "index" ? 2 : 0,
                action !== "finite",
            );
        fixture.state.commit();
        await fixture.render();
        assert.equal(
            (fixture.state.currentTrack as Track).id,
            action === "index" ? "wave-c" : "wave-a",
        );
    }
});

test("cleared Wave continuation waits for admission and skips denied candidates", async (t) => {
    const fixture = await clearedWaveFixture(t, 0);
    const policy = fixture.state.recommendationFeedback as Record<
        string,
        unknown
    >;
    let release!: () => void;
    policy.prepareTracks = () =>
        new Promise<"ready">((resolve) => {
            release = () => resolve("ready");
        });
    policy.readyFor = (track: Track) => track.id !== "wave-b";
    fixture.controls().playTracks(fixture.tracks, 0, true);
    await fixture.flush();
    assert.equal(fixture.state.currentTrack, null);
    release();
    await fixture.flush();
    assert.equal(currentTrackId(fixture.state), "wave-c");
    assert.equal(fixture.state.localTrackPlaybackOccurrence, 1);
});

test("automatic recommendation Next waits for policy and skips denied recordings without touching current early", async () => {
    const current = makeTrack("policy-current", "artist");
    const denied = makeTrack("policy-denied", "artist");
    const allowed = makeTrack("policy-allowed", "other");
    const state = createDeferredAudioState({
        queue: [current, denied, allowed],
        currentIndex: 0,
        currentTrack: current,
        playbackType: "track",
    });
    let release!: (value: "ready") => void;
    const gate = new Promise<"ready">((resolve) => {
        release = resolve;
    });
    const feedback = state.recommendationFeedback as Record<string, unknown>;
    feedback.prepareAdvance = () => gate;
    feedback.readyFor = (track: Track) => track.id !== denied.id;
    const playback = createPlaybackStub({ currentTime: 37, duration: 200 });
    playback.isPlaying = true;
    const controls = await renderControls({ state, playback });
    controls.next();
    state.commit();
    assert.equal(
        (state.currentTrack as Track).id,
        current.id,
        "current source is retained while the policy is pending",
    );
    assert.equal(playback.currentTime, 37);
    assert.equal(playback.isPlaying, true);
    release("ready");
    await flushAsync();
    state.commit();
    assert.equal((state.currentTrack as Track).id, allowed.id);
    assert.equal(state.currentIndex, 2);
});

test("Pause retires pending recommendation Next so a late policy cannot change the selected track", async () => {
    const current = makeTrack("policy-paused", "artist"),
        next = makeTrack("policy-next", "other");
    const state = createDeferredAudioState({
        queue: [current, next],
        currentIndex: 0,
        currentTrack: current,
        playbackType: "track",
    });
    let release!: (value: "ready") => void;
    const gate = new Promise<"ready">((resolve) => {
        release = resolve;
    });
    (state.recommendationFeedback as Record<string, unknown>).prepareAdvance =
        () => gate;
    const playback = createPlaybackStub({ currentTime: 37 });
    playback.isPlaying = true;
    const controls = await renderControls({ state, playback });
    controls.next();
    controls.pause();
    state.commit();
    release("ready");
    await flushAsync();
    state.commit();
    assert.equal((state.currentTrack as Track).id, current.id);
    assert.equal(playback.currentTime, 37);
    assert.equal(playback.isPlaying, false);
});

test("unavailable policy at a natural end does not restart or select an unchecked recommendation", async () => {
    const current = makeTrack("policy-ended", "artist"),
        next = makeTrack("policy-unknown", "other");
    const state = createDeferredAudioState({
        queue: [current, next],
        currentIndex: 0,
        currentTrack: current,
        playbackType: "track",
    });
    let release!: (value: "unavailable") => void;
    const gate = new Promise<"unavailable">((resolve) => {
        release = resolve;
    });
    (state.recommendationFeedback as Record<string, unknown>).prepareAdvance =
        () => gate;
    const playback = createPlaybackStub({ currentTime: 200, duration: 200 });
    playback.isPlaying = true;
    const controls = await renderControls({ state, playback });
    controls.advanceQueue(null);
    state.commit();
    assert.equal((state.currentTrack as Track).id, current.id);
    assert.equal(
        playback.isPlaying,
        false,
        "retire the completed track intent while waiting",
    );
    release("unavailable");
    await flushAsync();
    state.commit();
    assert.equal((state.currentTrack as Track).id, current.id);
    assert.equal(playback.currentTime, 200);
});

function makeTrack(id: string, artistId: string) {
    return {
        id,
        title: `Track ${id}`,
        duration: 200,
        artist: { id: artistId, name: `Artist ${artistId}` },
        album: { id: `album-${id}`, title: `Album ${id}` },
    };
}

async function makeEpisodeQueueItem(
    podcastId: string,
    episodeId: string,
    duration = 1800,
) {
    const { buildEpisodeQueueItem } = await import("../../lib/queue-item");
    return buildEpisodeQueueItem({
        podcastId,
        episodeId,
        title: `Episode ${episodeId}`,
        podcastTitle: "Podcast",
        coverUrl: null,
        duration,
    });
}

test("removeFromQueue of the playing last episode persists its progress and starts the remaining track", async () => {
    const trackA = makeTrack("t1", "a1");
    const outgoing = await makeEpisodeQueueItem("pod1", "ep1", 3600);
    const state = createDeferredAudioState({
        queue: [trackA, outgoing],
        currentIndex: 1,
        playbackType: "podcast",
        currentPodcast: {
            id: outgoing.id,
            title: outgoing.title,
            podcastTitle: outgoing.podcastTitle,
            coverUrl: null,
            duration: 3600,
            progress: { currentTime: 500, progress: 14, isFinished: false },
        },
    });
    const playback = createPlaybackStub({ currentTime: 500, duration: 3600 });

    const controls = await renderControls({ state, playback });
    controls.removeFromQueue(1);
    state.commit();

    // The playing episode's position must be persisted before the switch.
    assert.deepEqual(apiCalls.updatePodcastProgress, [
        ["pod1", "ep1", 500, 3600, false],
    ]);

    assert.equal((state.queue as unknown[]).length, 1);
    assert.equal(state.currentIndex, 0);
    assert.equal((state.currentTrack as { id: string }).id, "t1");
    assert.equal(state.playbackType, "track");
    assert.equal(state.currentPodcast, null);
    assert.equal(playback.isPlaying, true);
    assert.equal(playback.currentTime, 0);
});

test("removeFromQueue of the playing last item resumes the new current episode from saved progress", async () => {
    const upNext = await makeEpisodeQueueItem("pod1", "ep2", 1800);
    const outgoing = await makeEpisodeQueueItem("pod1", "ep1", 3600);
    getPodcastImpl.current = async () => ({
        episodes: [
            {
                id: "ep2",
                title: upNext.title,
                duration: 1800,
                progress: { currentTime: 111, progress: 6, isFinished: false },
            },
        ],
    });
    const state = createDeferredAudioState({
        queue: [upNext, outgoing],
        currentIndex: 1,
        playbackType: "podcast",
        currentPodcast: {
            id: outgoing.id,
            title: outgoing.title,
            podcastTitle: outgoing.podcastTitle,
            coverUrl: null,
            duration: 3600,
            progress: { currentTime: 500, progress: 14, isFinished: false },
        },
    });
    const playback = createPlaybackStub({ currentTime: 500, duration: 3600 });

    const controls = await renderControls({ state, playback });
    controls.removeFromQueue(1);
    state.commit();
    await flushAsync();
    state.commit();

    assert.deepEqual(apiCalls.updatePodcastProgress, [
        ["pod1", "ep1", 500, 3600, false],
    ]);

    assert.equal(state.currentIndex, 0);
    assert.equal(state.playbackType, "podcast");
    const current = state.currentPodcast as {
        id: string;
        progress: { currentTime: number } | null;
    };
    assert.equal(current.id, upNext.id);
    // The partially-listened episode resumes instead of restarting at 0:00.
    assert.equal(current.progress?.currentTime, 111);
    assert.equal(playback.currentTime, 111);
    assert.equal(playback.isPlaying, true);
});

test("addTracksToQueue over a legacy playing episode seeds a real shuffle order", async (t) => {
    t.mock.method(Math, "random", () => 0);

    const state = createDeferredAudioState({
        queue: [],
        currentIndex: 0,
        playbackType: "podcast",
        currentPodcast: {
            id: "pod1:ep1",
            title: "Episode ep1",
            podcastTitle: "Podcast",
            coverUrl: null,
            duration: 1800,
            progress: null,
        },
        isShuffle: true,
        shuffleIndices: [],
    });
    const playback = createPlaybackStub();

    const controls = await renderControls({ state, playback });
    controls.addTracksToQueue(
        [makeTrack("t1", "a1"), makeTrack("t2", "a2"), makeTrack("t3", "a3")],
        { silent: true },
    );
    state.commit();

    const queue = state.queue as Array<{ id: string }>;
    assert.equal(queue.length, 4);
    assert.equal(queue[0].id, "pod1:ep1");
    assert.equal(state.currentIndex, 0);

    const indices = state.shuffleIndices as number[];
    assert.equal(indices.length, 4);
    // The playing episode keeps position 0 in the shuffle order.
    assert.equal(indices[0], 0);
    // All queue positions participate exactly once...
    assert.deepEqual(
        [...indices].sort((a, b) => a - b),
        [0, 1, 2, 3],
    );
    // ...and the order is actually shuffled, not the sequential identity.
    assert.notDeepEqual(indices, [0, 1, 2, 3]);
});

test("rapid addEpisodeToQueue calls append distinct shuffle indices", async () => {
    const state = createDeferredAudioState({
        queue: [makeTrack("t1", "a1"), makeTrack("t2", "a2")],
        currentIndex: 0,
        playbackType: "track",
        currentTrack: makeTrack("t1", "a1"),
        isShuffle: true,
        shuffleIndices: [0, 1],
    });
    const playback = createPlaybackStub();

    const makeEpisode = (id: string): Episode =>
        ({
            id,
            title: `Ep ${id}`,
            duration: 900,
            progress: null,
        }) as unknown as Episode;
    const podcastMeta = { id: "pod1", title: "Podcast", coverUrl: null };

    const controls = await renderControls({ state, playback });
    controls.addEpisodeToQueue(makeEpisode("ep1"), podcastMeta);
    controls.addEpisodeToQueue(makeEpisode("ep2"), podcastMeta);
    state.commit();

    assert.equal((state.queue as unknown[]).length, 4);
    const indices = state.shuffleIndices as number[];
    // Every queue position must appear exactly once; the stale-snapshot bug
    // appended the same index twice so one position never played in shuffle.
    assert.deepEqual(
        [...indices].sort((a, b) => a - b),
        [0, 1, 2, 3],
    );
});

test("rapid addTracksToQueue appends stamp distinct shuffle indices", async () => {
    const state = createDeferredAudioState({
        queue: [makeTrack("t1", "a1"), makeTrack("t2", "a2")],
        currentIndex: 0,
        playbackType: "track",
        currentTrack: makeTrack("t1", "a1"),
        isShuffle: true,
        shuffleIndices: [0, 1],
    });
    const playback = createPlaybackStub();

    const controls = await renderControls({ state, playback });
    controls.addTracksToQueue([makeTrack("t3", "a3")], { silent: true });
    controls.addTracksToQueue([makeTrack("t4", "a4")], { silent: true });
    state.commit();

    assert.equal((state.queue as unknown[]).length, 4);
    const indices = state.shuffleIndices as number[];
    assert.deepEqual(
        [...indices].sort((a, b) => a - b),
        [0, 1, 2, 3],
    );
});

test("rapid next() skips advance past an episode while its progress lookup is pending", async () => {
    const pendingLookups: Array<(value: unknown) => void> = [];
    getPodcastImpl.current = () =>
        new Promise((resolve) => {
            pendingLookups.push(resolve);
        });

    const ep1 = await makeEpisodeQueueItem("pod1", "ep1");
    const ep2 = await makeEpisodeQueueItem("pod1", "ep2");
    const state = createDeferredAudioState({
        queue: [makeTrack("t1", "a1"), ep1, ep2],
        currentIndex: 0,
        playbackType: "track",
        currentTrack: makeTrack("t1", "a1"),
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "off",
    });
    const playback = createPlaybackStub({ currentTime: 42, duration: 200 });

    const controls = await renderControls({ state, playback });

    // First skip lands on the first episode; the index must advance
    // immediately even though the saved-progress lookup is still pending.
    controls.next();
    state.commit();
    assert.equal(state.currentIndex, 1);

    // Second skip within the lookup window must move PAST the episode
    // instead of re-resolving to the same index (the dead-air bug).
    controls.next();
    state.commit();
    assert.equal(state.currentIndex, 2);

    // Late lookups settle: the stale ep1 resolution must not clobber ep2.
    for (const resolve of pendingLookups) {
        resolve({ episodes: [] });
    }
    await flushAsync();
    state.commit();

    assert.equal(state.currentIndex, 2);
    assert.equal(state.playbackType, "podcast");
    assert.equal((state.currentPodcast as { id: string }).id, ep2.id);
    assert.equal(playback.isPlaying, true);
});

test("error advance bypasses repeat-one and selects the next track", async () => {
    const currentTrack = makeTrack("repeat-bad", "artist-1");
    const nextTrack = makeTrack("repeat-good", "artist-2");
    const state = createDeferredAudioState({
        queue: [currentTrack, nextTrack],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
        repeatMode: "one",
        repeatOneCount: 0,
    });
    const playback = createPlaybackStub({ currentTime: 42, duration: 200 });
    const controls = await renderControls({ state, playback });

    controls.advanceQueue("error");
    state.commit();

    assert.equal(state.currentIndex, 1);
    assert.equal((state.currentTrack as { id: string }).id, "repeat-good");
});

test("feedback advance bypasses repeat-one and selects the next track", async () => {
    const currentTrack = makeTrack("disliked-current", "artist-1");
    const nextTrack = makeTrack("wave-next", "artist-2");
    const state = createDeferredAudioState({
        queue: [currentTrack, nextTrack],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
        repeatMode: "one",
        repeatOneCount: 0,
    });
    const playback = createPlaybackStub({ currentTime: 42, duration: 200 });
    const controls = await renderControls({ state, playback });

    controls.advanceQueue("feedback");
    state.commit();

    assert.equal(state.currentIndex, 1);
    assert.equal((state.currentTrack as { id: string }).id, "wave-next");
});

test("disliking a recommended song removes exact repeats while retaining another recording by the artist", async () => {
    const currentTrack = {
        ...makeTrack("disliked-current", "artist-1"),
        recommendationGenerationId: "generation-1",
    };
    const sameArtistOne = { ...currentTrack };
    const otherArtist = makeTrack("other-artist", "artist-2");
    const sameArtistTwo = makeTrack("same-artist-2", "artist-1");
    const state = createDeferredAudioState({
        queue: [currentTrack, sameArtistOne, otherArtist, sameArtistTwo],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
    });
    const playback = createPlaybackStub();
    const controls = await renderControls({ state, playback });

    controls.advanceQueue("feedback");
    state.commit();

    assert.deepEqual(
        (state.queue as Array<{ id: string }>).map((item) => item.id),
        ["disliked-current", "other-artist", "same-artist-2"],
    );
    assert.equal(state.currentIndex, 1);
    assert.equal((state.currentTrack as { id: string }).id, "other-artist");
});

test("feedback remaps shuffled recommendations while keeping played history", async () => {
    const currentTrack = {
        ...makeTrack("current", "artist-1"),
        recommendationGenerationId: "generation-1",
    };
    const previous = makeTrack("previous", "artist-1");
    const other = makeTrack("other", "artist-2");
    const later = { ...currentTrack };
    const state = createDeferredAudioState({
        queue: [later, previous, other, currentTrack],
        currentIndex: 3,
        currentTrack,
        playbackType: "track",
        isShuffle: true,
        shuffleIndices: [1, 3, 0, 2],
    });
    const controls = await renderControls({
        state,
        playback: createPlaybackStub(),
    });

    controls.advanceQueue("feedback");
    state.commit();

    assert.deepEqual(
        (state.queue as Array<{ id: string }>).map((item) => item.id),
        ["previous", "other", "current"],
    );
    assert.deepEqual(state.shuffleIndices, [0, 2, 1]);
    assert.equal(state.currentIndex, 1);
    assert.equal((state.currentTrack as { id: string }).id, "other");
});

test("feedback keeps the rest of an explicitly selected album queue", async () => {
    const currentTrack = makeTrack("current", "artist-1");
    const nextTrack = makeTrack("next", "artist-1");
    const state = createDeferredAudioState({
        queue: [currentTrack, nextTrack],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
    });
    const controls = await renderControls({
        state,
        playback: createPlaybackStub(),
    });

    controls.advanceQueue("feedback");
    state.commit();

    assert.deepEqual(
        (state.queue as Array<{ id: string }>).map((item) => item.id),
        ["current", "next"],
    );
    assert.equal(state.currentIndex, 1);
});

test("feedback stops when only exact repeats of the rejected recording remain", async () => {
    const currentTrack = {
        ...makeTrack("current", "artist-1"),
        recommendationGenerationId: "generation-1",
    };
    const state = createDeferredAudioState({
        queue: [currentTrack, { ...currentTrack }],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
    });
    const playback = createPlaybackStub();
    playback.isPlaying = true;
    const controls = await renderControls({ state, playback });

    controls.advanceQueue("feedback");
    state.commit();

    assert.deepEqual(
        (state.queue as Array<{ id: string }>).map((item) => item.id),
        ["current"],
    );
    assert.equal(playback.isPlaying, false);
});

test("feedback removes exact repeats from a personal style mix without rejecting its other recordings", async () => {
    const currentTrack = {
        ...makeTrack("current", "artist-1"),
        recommendationSessionId: "session-1",
    };
    const state = createDeferredAudioState({
        queue: [
            currentTrack,
            { ...currentTrack },
            makeTrack("same-artist", "artist-1"),
            makeTrack("other", "artist-2"),
        ],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
    });
    const controls = await renderControls({
        state,
        playback: createPlaybackStub(),
    });

    controls.advanceQueue("feedback");
    state.commit();

    assert.deepEqual(
        (state.queue as Array<{ id: string }>).map((item) => item.id),
        ["current", "same-artist", "other"],
    );
});

test("feedback at the end of repeat-all continues with another artist", async () => {
    const currentTrack = {
        ...makeTrack("current", "artist-1"),
        recommendationGenerationId: "generation-1",
    };
    const other = makeTrack("other", "artist-2");
    const state = createDeferredAudioState({
        queue: [other, currentTrack],
        currentIndex: 1,
        currentTrack,
        playbackType: "track",
        repeatMode: "all",
    });
    const controls = await renderControls({
        state,
        playback: createPlaybackStub(),
    });

    controls.advanceQueue("feedback");
    state.commit();

    assert.equal(state.currentIndex, 0);
    assert.equal((state.currentTrack as { id: string }).id, "other");
});

test("manual next keeps repeat-one behavior", async () => {
    const currentTrack = makeTrack("repeat-current", "artist-1");
    const nextTrack = makeTrack("repeat-next", "artist-2");
    const state = createDeferredAudioState({
        queue: [currentTrack, nextTrack],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
        repeatMode: "one",
        repeatOneCount: 0,
    });
    const playback = createPlaybackStub({ currentTime: 42, duration: 200 });
    const controls = await renderControls({ state, playback });

    controls.next();
    state.commit();

    assert.equal(state.currentIndex, 0);
    assert.equal((state.currentTrack as { id: string }).id, "repeat-current");
    assert.equal(state.repeatOneCount, 1);
});

test("shuffle toggle keeps the flag and shuffle order unambiguous on and off", async () => {
    const currentTrack = makeTrack("shuffle-current", "artist-1");
    const state = createDeferredAudioState({
        queue: [
            currentTrack,
            makeTrack("shuffle-next", "artist-2"),
            makeTrack("shuffle-last", "artist-3"),
        ],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
        isShuffle: false,
        shuffleIndices: [],
    });
    const controls = await renderControls({
        state,
        playback: createPlaybackStub(),
    });

    controls.toggleShuffle();
    state.commit();

    assert.equal(state.isShuffle, true);
    assert.deepEqual(
        [...(state.shuffleIndices as number[])].sort((a, b) => a - b),
        [0, 1, 2],
    );

    controls.toggleShuffle();
    state.commit();

    assert.equal(state.isShuffle, false);
    assert.deepEqual(state.shuffleIndices, []);
});

test("persisted active shuffle rebuilds its missing factual order on mount", async (testContext) => {
    const currentTrack = makeTrack("persisted-shuffle", "artist-1");
    const state = createDeferredAudioState({
        queue: [
            currentTrack,
            makeTrack("persisted-next", "artist-2"),
            makeTrack("persisted-last", "artist-3"),
        ],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
        isShuffle: true,
        shuffleIndices: [],
    });
    stateHolder.current = state;
    playbackHolder.current = createPlaybackStub();

    const [{ AudioControlsProvider, useAudioControls }, { createRoot }] =
        await Promise.all([
            import("../../lib/audio-controls-context"),
            import("react-dom/client"),
        ]);
    const controlsRef: {
        current: ReturnType<typeof useAudioControls> | null;
    } = { current: null };
    const Probe = () => {
        controlsRef.current = useAudioControls();
        return React.createElement("div", null, "ready");
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    testContext.after(async () => {
        await React.act(async () => root.unmount());
        container.remove();
    });

    await React.act(async () => {
        root.render(
            React.createElement(
                AudioControlsProvider,
                null,
                React.createElement(Probe),
            ),
        );
        await Promise.resolve();
    });
    state.commit();

    assert.deepEqual(
        [...(state.shuffleIndices as number[])].sort((a, b) => a - b),
        [0, 1, 2],
    );
    assert.ok(controlsRef.current);
    controlsRef.current.next();
    state.commit();
    assert.notEqual(state.currentIndex, 0);
});

test("provider radio extends the played shuffle order without replaying old tracks", async () => {
    const currentTrack = {
        ...makeTrack("yt:AAAAAAAAAAA", "provider-artist"),
        streamSource: "youtube" as const,
        youtubeVideoId: "AAAAAAAAAAA",
        provider: {
            source: "youtube" as const,
            youtubeVideoId: "AAAAAAAAAAA",
        },
    };
    const alreadyPlayedFirst = makeTrack("already-played-1", "artist-1");
    const alreadyPlayedSecond = makeTrack("already-played-2", "artist-2");
    personalizedFeed.current = {
        shelves: {
            discovery: [
                {
                    id: "yt:BBBBBBBBBBB",
                    title: "Fresh provider track",
                    duration: 180,
                    trackNo: null,
                    artist: { id: null, name: "Fresh artist" },
                    album: {
                        id: null,
                        title: "Fresh album",
                        coverArt: null,
                    },
                    source: "youtube",
                    provider: {
                        tidalTrackId: null,
                        youtubeVideoId: "BBBBBBBBBBB",
                    },
                    streamSource: "youtube",
                    youtubeVideoId: "BBBBBBBBBBB",
                },
            ],
            quickPicks: [],
            listenAgain: [],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    };
    const state = createDeferredAudioState({
        queue: [alreadyPlayedFirst, currentTrack, alreadyPlayedSecond],
        currentIndex: 1,
        currentTrack,
        playbackType: "track",
        isShuffle: true,
        shuffleIndices: [2, 0, 1],
    });
    const controls = await renderControls({
        state,
        playback: createPlaybackStub(),
    });

    const result = await controls.startVibeMode();
    state.commit();

    assert.deepEqual(result, { success: true, trackCount: 1 });
    assert.deepEqual(
        (state.queue as Array<{ youtubeVideoId?: string }>).map(
            (track) => track.youtubeVideoId,
        ),
        [undefined, "AAAAAAAAAAA", undefined, "BBBBBBBBBBB"],
    );
    assert.equal(state.isShuffle, true);
    assert.deepEqual(state.shuffleIndices, [2, 0, 1, 3]);
    assert.equal(state.vibeMode, true);
    assert.deepEqual(state.vibeQueueIds, ["yt:AAAAAAAAAAA", "yt:BBBBBBBBBBB"]);

    controls.next();
    state.commit();
    assert.equal(state.currentIndex, 3);
    assert.equal(
        (state.currentTrack as { youtubeVideoId?: string }).youtubeVideoId,
        "BBBBBBBBBBB",
    );
});

test("mixed Wave skips and dislikes refresh only the tail and respect a subsequent pause", async (t) => {
    const currentTrack = {
        ...makeTrack("yt:AAAAAAAAAAA", "provider-artist"),
        streamSource: "youtube" as const,
        youtubeVideoId: "AAAAAAAAAAA",
        provider: {
            source: "youtube" as const,
            youtubeVideoId: "AAAAAAAAAAA",
        },
    };
    const staleTracks = ["BBBBBBBBBBB", "CCCCCCCCCCC", "EEEEEEEEEEE"].map(
        (videoId) => ({
            ...makeTrack(`yt:${videoId}`, `artist-${videoId}`),
            streamSource: "youtube" as const,
            youtubeVideoId: videoId,
            provider: { source: "youtube" as const, youtubeVideoId: videoId },
        }),
    );
    const freshVideoId = "DDDDDDDDDDD";
    personalizedFeed.current = {
        shelves: {
            discovery: [
                {
                    id: `yt:${freshVideoId}`,
                    title: "Fresh adaptive track",
                    duration: 180,
                    trackNo: null,
                    artist: { id: null, name: "Fresh Artist" },
                    album: { id: null, title: "Fresh Album", coverArt: null },
                    source: "youtube",
                    provider: {
                        tidalTrackId: null,
                        youtubeVideoId: freshVideoId,
                    },
                    streamSource: "youtube",
                    youtubeVideoId: freshVideoId,
                },
            ],
            quickPicks: [],
            listenAgain: [],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    };
    const state = createDeferredAudioState({
        queue: [currentTrack, ...staleTracks],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
        vibeMode: true,
        vibeQueueIds: [
            currentTrack.id,
            ...staleTracks.map((track) => track.id),
        ],
    });
    const playback = createPlaybackStub({ currentTime: 5, duration: 200 });
    let releaseFeed!: () => void;
    personalizedFeedGate.current = new Promise<void>((resolve) => {
        releaseFeed = resolve;
    });
    stateHolder.current = state;
    playbackHolder.current = playback;
    apiCalls.personalizedRequests.length = 0;
    const { AudioControlsProvider, useAudioControls } =
        await import("../../lib/audio-controls-context");
    const { createRoot } = await import("react-dom/client");
    const controlsRef: { current: ReturnType<typeof useAudioControls> | null } =
        { current: null };
    function Probe() {
        controlsRef.current = useAudioControls();
        return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => {
        releaseFeed();
        await React.act(async () => root.unmount());
        container.remove();
    });
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
    await render();
    for (const action of ["manual", "feedback", "manual"] as const) {
        assert.ok(controlsRef.current);
        playback.currentTime = action === "feedback" ? 90 : 5;
        controlsRef.current.advanceQueue(action);
        state.commit();
        await render();
    }
    // While recommendations are pending, the listener pauses the selection.
    playback.currentTime = 7;
    controlsRef.current!.pause();
    await React.act(async () => {
        releaseFeed();
        await flushAsync();
    });
    state.commit();

    assert.equal(apiCalls.personalizedRequests.length, 1);
    assert.equal(
        (state.currentTrack as { youtubeVideoId?: string }).youtubeVideoId,
        "EEEEEEEEEEE",
    );
    assert.deepEqual(
        (state.queue as Array<{ youtubeVideoId?: string }>).map(
            (track) => track.youtubeVideoId,
        ),
        [
            "AAAAAAAAAAA",
            "BBBBBBBBBBB",
            "CCCCCCCCCCC",
            "EEEEEEEEEEE",
            freshVideoId,
        ],
    );
    assert.equal(state.currentIndex, 3);
    assert.equal(playback.currentTime, 7);
    assert.equal(playback.isPlaying, false);
});

for (const scenario of [
    "legacy",
    "legacy POST delayed",
    "keyed POST delayed",
    "reverse ACK paused",
    "ACK during initial GET",
    "owner replaced",
    "API owner replaced",
    "failed PATCH",
] as const) {
    test(`adaptive continuation includes the latest committed skip without delaying current playback: ${scenario}`, async (t) => {
        const { AudioControlsProvider, useAudioControls } =
            await import("../../lib/audio-controls-context");
        const { usePlayEngagementTracking } =
            await import("../../components/player/hooks/usePlayEngagementTracking");
        const { createRoot } = await import("react-dom/client");
        const deferred = () => {
            let release!: () => void;
            const promise = new Promise<void>((resolve) => {
                release = resolve;
            });
            return { promise, release };
        };
        const latestPatch = deferred();
        const tasteRead = deferred();
        const created = deferred();
        const previousPatches = [deferred(), deferred()];
        const committed = new Map<string, PlayEngagementInput>();
        const attempted: string[] = [];
        const readVersions: number[] = [];
        const keyedObservers = new Map<
            string,
            Set<(input: PlayEngagementInput) => void>
        >();
        const isPostDelayed = scenario.includes("POST delayed");
        const create = async (input: PlayLogInput) => {
            const videoId =
                "youtubeVideoId" in input ? input.youtubeVideoId : "other";
            if (isPostDelayed && videoId === "CCCCCCCCCCC")
                await created.promise;
            return { id: `play-${videoId}` };
        };
        playCreateImpl.current = create;
        if (scenario === "keyed POST delayed") {
            const dispose = installPlayCreateJournalBridge({
                api: {},
                authLease: getAuthRuntimeLease(),
                runtime: {
                    begin(input) {
                        const result = create(input);
                        const videoId =
                            "youtubeVideoId" in input
                                ? input.youtubeVideoId
                                : "other";
                        const listeners = new Set<
                            (input: PlayEngagementInput) => void
                        >();
                        keyedObservers.set(`play-${videoId}`, listeners);
                        return {
                            key: `key-${videoId}`,
                            mode: "keyed" as const,
                            persisted: Promise.resolve(true),
                            created: result,
                            observeEngagementCommits(listener) {
                                listeners.add(listener);
                                return () => listeners.delete(listener);
                            },
                            async noteEngagement(totals, final) {
                                const write = engagementWriteImpl.current;
                                if (final && write)
                                    void result
                                        .then(({ id }) => write(id, totals))
                                        .then(() => {
                                            for (const listener of listeners)
                                                listener(totals);
                                        })
                                        .catch(() => undefined);
                                // Local journal persistence is deliberately earlier than server commit.
                                return true;
                            },
                        };
                    },
                    async close() {},
                    suspendForHistoryClear: () => async () => undefined,
                },
            });
            t.after(dispose);
        }
        const providerTrack = (videoId: string) => ({
            ...makeTrack(`yt:${videoId}`, `artist-${videoId}`),
            duration: 200,
            streamSource: "youtube" as const,
            youtubeVideoId: videoId,
            provider: { source: "youtube" as const, youtubeVideoId: videoId },
        });
        const queue = [
            "AAAAAAAAAAA",
            "BBBBBBBBBBB",
            "CCCCCCCCCCC",
            "DDDDDDDDDDD",
            "EEEEEEEEEEE",
        ].map(providerTrack);
        const state = createDeferredAudioState({
            queue,
            currentTrack: queue[0],
            currentIndex: 0,
            playbackType: "track",
            vibeMode: true,
            vibeQueueIds: queue.map((track) => track.id),
        });
        const playback = createPlaybackStub({ currentTime: 5, duration: 200 });
        playback.isPlaying = true;
        stateHolder.current = state;
        playbackHolder.current = playback;
        apiCalls.personalizedRequests.length = 0;
        engagementWriteImpl.current = async (playId, input) => {
            attempted.push(playId);
            if (
                scenario === "reverse ACK paused" &&
                playId !== "play-CCCCCCCCCCC"
            ) {
                await previousPatches[playId === "play-AAAAAAAAAAA" ? 0 : 1]
                    .promise;
            }
            if (playId === "play-CCCCCCCCCCC") await latestPatch.promise;
            if (scenario === "failed PATCH" && playId === "play-CCCCCCCCCCC")
                throw new Error("controlled PATCH failure");
            // Only an acknowledged PATCH changes this fake server's persisted taste.
            committed.set(playId, input);
            return { success: true };
        };
        const freshId = "GGGGGGGGGGG";
        const staleId = "FFFFFFFFFFF";
        personalizedRequestImpl.current = async () => {
            // The read and write are independent upstream operations, ordered by latches.
            await tasteRead.promise;
            readVersions.push(committed.size);
            const videoId =
                committed.size === 3
                    ? scenario === "ACK during initial GET" &&
                      readVersions.length > 1
                        ? "IIIIIIIIIII"
                        : freshId
                    : staleId;
            return {
                shelves: {
                    discovery: [
                        {
                            ...providerTrack(videoId),
                            source: "youtube",
                            provider: {
                                tidalTrackId: null,
                                youtubeVideoId: videoId,
                            },
                        },
                    ],
                    quickPicks: [],
                    listenAgain: [],
                },
                degraded: false,
                reason: null,
                seedCount: 1,
            };
        };
        const controlsRef: {
            current: ReturnType<typeof useAudioControls> | null;
        } = { current: null };
        const engineOccurrenceIsCurrent = () => true;
        function MountedPlayer() {
            controlsRef.current = useAudioControls();
            // Mount the player's actual tracking hook beside its actual control provider.
            const tracking = usePlayEngagementTracking({
                currentTrack: state.currentTrack as Track,
                currentIndex: state.currentIndex as number,
                localTrackPlaybackOccurrence:
                    state.localTrackPlaybackOccurrence as number,
                playbackType: "track",
                isCurrentEngineOccurrence: engineOccurrenceIsCurrent,
                vibeMode: true,
                waveMode: "for-you",
            });
            React.useEffect(() => {
                tracking.noteProgress(0);
                tracking.noteProgress(5);
            }, [tracking.noteProgress]);
            return null;
        }
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        t.after(async () => {
            latestPatch.release();
            tasteRead.release();
            created.release();
            for (const gate of previousPatches) gate.release();
            await React.act(async () => root.unmount());
            container.remove();
        });
        const render = () =>
            React.act(async () => {
                root.render(
                    React.createElement(
                        AudioControlsProvider,
                        null,
                        React.createElement(MountedPlayer),
                    ),
                );
                await flushAsync();
            });
        await render();
        for (let index = 0; index < 3; index++) {
            playback.currentTime = 5;
            controlsRef.current!.advanceQueue("manual");
            state.commit();
            await render();
        }
        assert.deepEqual(
            attempted,
            isPostDelayed
                ? ["play-AAAAAAAAAAA", "play-BBBBBBBBBBB"]
                : ["play-AAAAAAAAAAA", "play-BBBBBBBBBBB", "play-CCCCCCCCCCC"],
        );
        assert.equal(committed.size, scenario === "reverse ACK paused" ? 0 : 2);
        assert.equal((state.currentTrack as Track).id, queue[3].id);
        assert.equal(playback.isPlaying, true);
        // A pending latest taste write must not delay selecting/playing the ready next row.
        const selected = state.currentTrack;
        playback.currentTime = 7;
        if (scenario === "reverse ACK paused") controlsRef.current!.pause();
        if (scenario === "ACK during initial GET") {
            await React.act(async () => {
                latestPatch.release();
                await flushAsync();
            });
            assert.equal(
                apiCalls.personalizedRequests.length,
                1,
                "dirty ACK during the first GET is coalesced",
            );
        }
        await React.act(async () => {
            tasteRead.release();
            await flushAsync();
        });
        state.commit();
        await render();
        assert.equal(
            apiCalls.personalizedRequests.length,
            scenario === "ACK during initial GET" ? 2 : 1,
        );
        if (scenario === "keyed POST delayed") {
            for (const listener of keyedObservers.get("play-CCCCCCCCCCC")!) {
                listener({
                    outcome: "meaningful",
                    listenedSeconds: 30,
                    completionRatio: 0.3,
                });
                listener({
                    outcome: "failed",
                    listenedSeconds: 5,
                    completionRatio: 0.025,
                });
            }
            await React.act(flushAsync);
            assert.equal(
                apiCalls.personalizedRequests.length,
                1,
                "local persistence, checkpoints and errors do not retune",
            );
        }
        if (scenario === "owner replaced") {
            controlsRef.current!.playTracks([providerTrack("HHHHHHHHHHH")]);
            state.commit();
            await render();
        }
        if (scenario === "API owner replaced") apiSessionGeneration++;
        await React.act(async () => {
            created.release();
            latestPatch.release();
            await flushAsync();
        });
        if (scenario === "reverse ACK paused") {
            assert.equal(
                apiCalls.personalizedRequests.length,
                1,
                "latest-first ACK waits for the other final skips",
            );
            await React.act(async () => {
                previousPatches[1].release();
                await flushAsync();
            });
            assert.equal(apiCalls.personalizedRequests.length, 1);
            await React.act(async () => {
                previousPatches[0].release();
                await flushAsync();
            });
        }
        state.commit();
        await render();
        if (scenario === "owner replaced") {
            assert.equal((state.currentTrack as Track).id, "yt:HHHHHHHHHHH");
            assert.equal(apiCalls.personalizedRequests.length, 1);
            return;
        }
        if (scenario === "API owner replaced") {
            assert.equal(apiCalls.personalizedRequests.length, 1);
            assert.equal(state.currentTrack, selected);
            return;
        }
        assert.equal(committed.size, scenario === "failed PATCH" ? 2 : 3);
        assert.equal(state.currentTrack, selected);
        assert.equal(playback.currentTime, 7);
        assert.equal(playback.isPlaying, scenario !== "reverse ACK paused");
        assert.equal(
            apiCalls.personalizedRequests.length,
            scenario === "failed PATCH" ? 1 : 2,
        );
        assert.equal(
            (state.queue as Track[]).at(-1)?.id,
            `yt:${scenario === "failed PATCH" ? staleId : scenario === "ACK during initial GET" ? "IIIIIIIIIII" : freshId}`,
            `continuation must include latest committed skip; read persisted versions=${readVersions.join(",")}`,
        );
    });
}

test("provider radio adds rich tracks to a Listen Together queue without local mutation", async () => {
    const currentTrack = {
        ...makeTrack("yt:AAAAAAAAAAA", "provider-artist"),
        streamSource: "youtube" as const,
        youtubeVideoId: "AAAAAAAAAAA",
        provider: {
            source: "youtube" as const,
            youtubeVideoId: "AAAAAAAAAAA",
        },
    };
    personalizedFeed.current = {
        shelves: {
            discovery: [
                {
                    id: "yt:BBBBBBBBBBB",
                    title: "Shared provider track",
                    duration: 180,
                    trackNo: null,
                    artist: { id: null, name: "Shared artist" },
                    album: {
                        id: null,
                        title: "Shared album",
                        coverArt: null,
                    },
                    source: "youtube",
                    provider: {
                        tidalTrackId: null,
                        youtubeVideoId: "BBBBBBBBBBB",
                    },
                    streamSource: "youtube",
                    youtubeVideoId: "BBBBBBBBBBB",
                },
            ],
            quickPicks: [],
            listenAgain: [],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    };
    listenTogetherSocketMock.hasActiveGroup = true;
    listenTogetherSocketMock.activeGroupId = "group-1";
    listenTogetherSession.current = {
        groupId: "group-1",
        isHost: false,
        playback: {
            isPlaying: true,
            positionMs: 0,
            serverTime: Date.now(),
            currentIndex: 0,
        },
    };
    const state = createDeferredAudioState({
        queue: [currentTrack],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
    });
    const controls = await renderControls({
        state,
        playback: createPlaybackStub(),
    });

    const result = await controls.startVibeMode();
    state.commit();

    assert.deepEqual(result, { success: true, trackCount: 1 });
    assert.equal(listenTogetherQueueCalls.length, 1);
    assert.deepEqual(listenTogetherQueueCalls[0], [
        {
            youtubeVideoId: "BBBBBBBBBBB",
            title: "Shared provider track",
            artist: "Shared artist",
            album: "Shared album",
            duration: 180,
        },
    ]);
    assert.deepEqual(state.queue, [currentTrack]);
    assert.equal(state.vibeMode, false);
});

test("moveQueueItem moves an upcoming item and remaps shuffle indices in lockstep", async () => {
    const tracks = ["t1", "t2", "t3", "t4", "t5"].map((id) => ({
        id,
        title: id,
        artist: { name: "a" },
        album: { title: "al" },
        duration: 100,
    }));
    const state = createDeferredAudioState({
        queue: tracks,
        currentIndex: 0,
        isShuffle: true,
        // Shuffle order references queue POSITIONS.
        shuffleIndices: [0, 4, 2, 1, 3],
    });
    const playback = createPlaybackStub({ currentTime: 0, duration: 100 });
    const controls = await renderControls({ state, playback });

    // Move position 1 (t2) to position 3.
    controls.moveQueueItem(1, 3);
    state.commit();

    assert.deepEqual(
        (state.queue as Array<{ id: string }>).map((t) => t.id),
        ["t1", "t3", "t4", "t2", "t5"],
    );
    // Every shuffle entry still points at the same TRACK it did before:
    // old positions map 0->0, 1->3, 2->1, 3->2, 4->4.
    assert.deepEqual(state.shuffleIndices, [0, 4, 1, 3, 2]);
});

test("moveQueueItem refuses to move the current row or cross into history", async () => {
    const tracks = ["t1", "t2", "t3"].map((id) => ({
        id,
        title: id,
        artist: { name: "a" },
        album: { title: "al" },
        duration: 100,
    }));
    const state = createDeferredAudioState({
        queue: tracks,
        currentIndex: 1,
    });
    const playback = createPlaybackStub({ currentTime: 0, duration: 100 });
    const controls = await renderControls({ state, playback });

    controls.moveQueueItem(1, 2); // current row itself
    controls.moveQueueItem(2, 1); // upcoming into the current slot
    controls.moveQueueItem(2, 0); // upcoming into history
    state.commit();

    assert.deepEqual(
        (state.queue as Array<{ id: string }>).map((t) => t.id),
        ["t1", "t2", "t3"],
    );
    assert.equal(state.currentIndex, 1);
});

test("repeat toggle resets two prior failures before the next failure", async () => {
    const currentTrack = makeTrack("repeat-current", "artist-1");
    const state = createDeferredAudioState({
        queue: [currentTrack],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
        repeatMode: "off",
    });
    const controls = await renderControls({
        state,
        playback: createPlaybackStub(),
    });
    const breaker = createConsecutiveErrorBreaker();
    breaker.recordError();
    breaker.recordError();

    controls.toggleRepeat();
    state.commit();
    const origin = consumePlaybackAdvanceOrigin();
    if (origin?.origin === "manual") breaker.reset();
    const tripped = breaker.recordError();

    assert.equal(state.repeatMode, "all");
    assert.equal(origin?.origin, "manual");
    assert.equal(tripped, false);
    assert.equal(breaker.getErrorCount(), 1);
});

test("clicking the playing occurrence toggles pause and resume without rebuilding its queue", async () => {
    const currentTrack = {
        ...makeTrack("repeat-click", "artist-1"),
        playlistItemId: "playlist-item-a",
        youtubeVideoId: "AAAAAAAAAAA",
    };
    const queue = [currentTrack, makeTrack("up-next", "artist-2")];
    const state = createDeferredAudioState({
        queue,
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
    });
    const playback = createPlaybackStub({ currentTime: 42, duration: 200 });
    playback.isPlaying = true;
    const controls = await renderControls({ state, playback });

    const beforePause = getExplicitPlaybackPauseGeneration();
    controls.playTracks([{ ...currentTrack }, queue[1]], 0);
    assert.ok(getExplicitPlaybackPauseGeneration() > beforePause);
    state.commit();
    assert.equal(playback.isPlaying, false);
    assert.equal(playback.currentTime, 42);
    assert.equal(state.queue, queue);

    controls.playTrack({ ...currentTrack });
    assert.equal(getExplicitPlaybackPauseGeneration(), 0);
    state.commit();
    assert.equal(playback.isPlaying, true);
    assert.equal(playback.currentTime, 42);
    assert.equal(state.queue, queue);

    controls.playTrack({
        ...currentTrack,
        playlistItemId: "playlist-item-b",
    });
    state.commit();
    assert.equal(playback.isPlaying, true);
    assert.equal(playback.currentTime, 0);
    assert.equal(
        (state.currentTrack as { playlistItemId?: string }).playlistItemId,
        "playlist-item-b",
    );
    assert.notEqual(state.queue, queue);
});

test("the shared UI and media-session pause action records explicit intent", async () => {
    const state = createDeferredAudioState({
        queue: [makeTrack("pause-intent", "artist-1")],
        currentIndex: 0,
        playbackType: "track",
    });
    const playback = createPlaybackStub({ currentTime: 42, duration: 200 });
    playback.isPlaying = true;
    const controls = await renderControls({ state, playback });
    const beforePause = getExplicitPlaybackPauseGeneration();
    controls.pause();
    assert.equal(playback.isPlaying, false);
    assert.ok(getExplicitPlaybackPauseGeneration() > beforePause);
    controls.resume();
    assert.equal(getExplicitPlaybackPauseGeneration(), 0);
});

test("explicit offline queue replacement works even when the selected track is already current", async () => {
    const currentTrack = makeTrack("downloaded", "artist-1");
    const localNext = makeTrack("also-downloaded", "artist-2");
    const state = createDeferredAudioState({
        queue: [currentTrack, makeTrack("online-only", "artist-3")],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
        vibeMode: true,
    });
    const playback = createPlaybackStub({ currentTime: 42, duration: 200 });
    playback.isPlaying = true;
    const controls = await renderControls({ state, playback });
    controls.playTracks([currentTrack, localNext], 0, false, {
        replaceQueue: true,
    });
    state.commit();
    assert.deepEqual(state.queue, [currentTrack, localNext]);
    assert.equal(state.vibeMode, false);
    assert.equal(playback.isPlaying, true);
    assert.equal(playback.currentTime, 0);
});

test("a downloaded three-track queue clears play intent after its final natural advance", async () => {
    const tracks = [3, 2, 1].map((id) => ({
        ...makeTrack(`yt:train00000${id}`, "train-check"),
        title: `Traincheck ${id}`,
        duration: 9,
    }));
    const state = createDeferredAudioState({});
    const playback = createPlaybackStub({ duration: 9 });
    let controls = await renderControls({ state, playback });

    // DownloadsList starts a complete local queue using this explicit action.
    controls.playTracks(tracks, 0, false, { replaceQueue: true });
    state.commit();
    for (let index = 0; index < tracks.length; index += 1) {
        assert.equal(state.currentIndex, index);
        assert.equal(
            (state.currentTrack as { id: string }).id,
            tracks[index].id,
        );
        assert.equal(playback.isPlaying, true);
        playback.currentTime = 9;
        controls = await renderControls({ state, playback });
        // This is also the online queue-end path when automatic matching
        // completes without appending any tracks.
        controls.advanceQueue(null);
        state.commit();
    }

    assert.equal(state.currentIndex, 2);
    assert.equal(playback.currentTime, 9);
    assert.equal(playback.isPlaying, false);
});

test("manual next at the last track keeps the unfinished track playing", async () => {
    const currentTrack = {
        ...makeTrack("last-playing", "artist"),
        duration: 9,
    };
    const state = createDeferredAudioState({
        queue: [currentTrack],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
    });
    const playback = createPlaybackStub({ currentTime: 4, duration: 9 });
    playback.isPlaying = true;
    const controls = await renderControls({ state, playback });

    controls.next();
    state.commit();

    assert.equal(playback.currentTime, 4);
    assert.equal(playback.isPlaying, true);
});

test("manual next at the Wave tail waits for one refill and advances once", async (t) => {
    const currentTrack = {
        ...makeTrack("yt:AAAAAAAAAAA", "provider-artist"),
        streamSource: "youtube" as const,
        youtubeVideoId: "AAAAAAAAAAA",
        provider: {
            source: "youtube" as const,
            youtubeVideoId: "AAAAAAAAAAA",
        },
    };
    const nextVideoId = "BBBBBBBBBBB";
    personalizedFeed.current = {
        shelves: {
            discovery: [
                {
                    id: `yt:${nextVideoId}`,
                    title: "Fresh tail track",
                    duration: 180,
                    trackNo: null,
                    artist: { id: null, name: "Fresh artist" },
                    album: {
                        id: null,
                        title: "Fresh album",
                        coverArt: null,
                    },
                    source: "youtube",
                    provider: {
                        tidalTrackId: null,
                        youtubeVideoId: nextVideoId,
                    },
                    streamSource: "youtube",
                    youtubeVideoId: nextVideoId,
                },
            ],
            quickPicks: [],
            listenAgain: [],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    };
    let releaseFeed!: () => void;
    personalizedFeedGate.current = new Promise<void>((resolve) => {
        releaseFeed = resolve;
    });
    const state = createDeferredAudioState({
        queue: [currentTrack],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
        vibeMode: true,
    });
    const playback = createPlaybackStub({ currentTime: 37, duration: 200 });
    playback.isPlaying = true;
    stateHolder.current = state;
    playbackHolder.current = playback;
    apiCalls.personalizedRequests.length = 0;

    const { AudioControlsProvider, useAudioControls } =
        await import("../../lib/audio-controls-context");
    const { createRoot } = await import("react-dom/client");
    const controlsRef: { current: ReturnType<typeof useAudioControls> | null } =
        { current: null };
    function Probe() {
        controlsRef.current = useAudioControls();
        return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => {
        releaseFeed();
        await React.act(async () => root.unmount());
        container.remove();
    });
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

    await render();
    await React.act(async () => {
        controlsRef.current?.next();
        controlsRef.current?.next();
        await flushAsync();
    });
    assert.equal(apiCalls.personalizedRequests.length, 1);
    assert.equal(state.currentIndex, 0);

    await React.act(async () => {
        releaseFeed();
        await flushAsync();
        state.commit();
    });
    await render();
    state.commit();

    assert.equal(state.currentIndex, 1);
    assert.equal(
        (state.currentTrack as { youtubeVideoId?: string }).youtubeVideoId,
        nextVideoId,
    );
    assert.equal(playback.currentTime, 0);
    assert.equal(playback.isPlaying, true);
});

for (const foreignSession of [false, true])
    test(`ordered Wave seed is bound to the actual cloned playback queue, foreignSession=${foreignSession}`, async () => {
        const raw = JSON.parse(
            readFileSync(
                new URL(
                    "../../../fixtures/ordered-wave-v1.json",
                    import.meta.url,
                ),
                "utf8",
            ),
        ).cases[0].orderedWave;
        const page = readOrderedWavePage({ orderedWave: raw })!;
        const tracks = page.items.map((row) =>
            toProviderPlaybackTrack(row.track),
        );
        const state = createDeferredAudioState({});
        const playback = createPlaybackStub();
        const controls = await renderControls({ state, playback });
        const owner = {
            authGeneration: 0,
            sessionId: foreignSession
                ? "foreign-tab"
                : getRecommendationSessionId(),
            intent: JSON.stringify(["for-you", null, "any"]),
        };
        controls.playTracks(tracks, 0, true, {
            replaceQueue: true,
            orderedWave: { page, owner },
        });
        state.commit();
        assert.notEqual(state.queue, tracks);
        assert.equal(
            orderedWaveQueueCheckpoints.capture(tracks, owner),
            undefined,
        );
        assert.equal(
            Boolean(
                orderedWaveQueueCheckpoints.capture(
                    state.queue as QueueItem[],
                    owner,
                ),
            ),
            !foreignSession,
        );
    });

test("radio queue startup enables continuation even when no previous Wave was active", async () => {
    const tracks = [makeTrack("seed", "artist"), makeTrack("next", "other")];
    const state = createDeferredAudioState({});
    const playback = createPlaybackStub();
    const controls = await renderControls({ state, playback });
    controls.playTracks(tracks, 0, true, { replaceQueue: true });
    state.commit();
    assert.equal(state.vibeMode, true);
});
test("radio origin is explicit on every queued occurrence and clears when a collection replaces it", async () => {
    const origin = {
        kind: "track" as const,
        source: "library" as const,
        id: "original",
    };
    const tracks = [makeTrack("seed", "a"), makeTrack("next", "b")];
    const state = createDeferredAudioState({});
    const playback = createPlaybackStub();
    let controls = await renderControls({ state, playback });
    controls.playTracks(tracks, 0, true, {
        replaceQueue: true,
        radioOrigin: origin,
    });
    state.commit();
    for (const track of state.queue as Array<{ radioOrigin?: unknown }>)
        assert.deepEqual(track.radioOrigin, origin);
    assert.deepEqual(
        (state.currentTrack as { radioOrigin?: unknown }).radioOrigin,
        origin,
    );
    controls = await renderControls({ state, playback });
    controls.playTracks(state.queue as typeof tracks, 0, false, {
        replaceQueue: true,
    });
    state.commit();
    for (const track of state.queue as Array<{ radioOrigin?: unknown }>)
        assert.equal(track.radioOrigin, undefined);
    assert.equal(
        (state.currentTrack as { radioOrigin?: unknown }).radioOrigin,
        undefined,
    );
});

test("upcoming radio stamps the retained song and tail without changing pause or position", async () => {
    const origin = {
        kind: "track" as const,
        source: "library" as const,
        id: "seed",
    };
    const seed = makeTrack("seed", "a");
    const state = createDeferredAudioState({
        currentTrack: seed,
        playbackType: "track",
        queue: [seed],
    });
    const playback = createPlaybackStub({ currentTime: 73 });
    const controls = await renderControls({ state, playback });
    controls.setUpcoming([makeTrack("next", "b")], true, true, {
        radioOrigin: origin,
    });
    state.commit();
    assert.deepEqual(
        (state.queue as Array<{ radioOrigin?: unknown }>).map(
            (t) => t.radioOrigin,
        ),
        [origin, origin],
    );
    assert.deepEqual(
        (state.currentTrack as { radioOrigin?: unknown }).radioOrigin,
        origin,
    );
    assert.equal(playback.currentTime, 73);
    assert.equal(playback.isPlaying, false);
});

test("radio upcoming replacement enables continuation without restarting the current song", async () => {
    const seed = makeTrack("seed", "artist");
    const next = makeTrack("next", "other");
    const state = createDeferredAudioState({
        isShuffle: true,
        currentTrack: seed,
        playbackType: "track",
        queue: [seed],
    });
    const playback = createPlaybackStub({ currentTime: 73 });
    const controls = await renderControls({ state, playback });
    controls.setUpcoming([next], true, true);
    state.commit();
    assert.equal(state.isShuffle, false);
    assert.equal(state.vibeMode, true);
    assert.equal(playback.currentTime, 73);
    assert.equal(state.currentTrack, seed);
    assert.deepEqual(state.queue, [seed, next]);
});

test("ordered queue explicitly clears shuffle from the previous context", async () => {
    const tracks = [makeTrack("first", "a"), makeTrack("second", "b")];
    const state = createDeferredAudioState({
        isShuffle: true,
        shuffleIndices: [1, 0],
    });
    const playback = createPlaybackStub();
    const controls = await renderControls({ state, playback });
    controls.playTracks(tracks, 0, false, {
        replaceQueue: true,
        preserveOrder: true,
    });
    state.commit();
    assert.equal(state.isShuffle, false);
    assert.deepEqual(state.shuffleIndices, []);
});

test("upcoming queue replacement supersedes a pending radio request", async () => {
    const { requestRadioQueue } =
        await import("../../lib/radio/radioRequestIntent");
    const seed = makeTrack("seed", "artist");
    const state = createDeferredAudioState({
        currentTrack: seed,
        playbackType: "track",
        queue: [seed],
    });
    const playback = createPlaybackStub({ currentTime: 73 });
    const controls = await renderControls({ state, playback });
    let resolve!: (tracks: ReturnType<typeof makeTrack>[]) => void;
    const pending = requestRadioQueue(
        () =>
            new Promise<ReturnType<typeof makeTrack>[]>((yes) => {
                resolve = yes;
            }),
    );
    const replacement = makeTrack("chosen", "artist");
    controls.setUpcoming([replacement], true, true);
    state.commit();
    resolve([makeTrack("stale", "artist")]);
    assert.equal(await pending, null);
    assert.deepEqual(state.queue, [seed, replacement]);
    assert.equal(playback.currentTime, 73);
});

for (const action of [
    "pending-radio",
    "replace-queue",
    "replace-upcoming",
] as const) {
    test(`adaptive refresh cannot overwrite ${action}`, async () => {
        const seed = {
            ...makeTrack("yt:AAAAAAAAAAA", "a"),
            streamSource: "youtube" as const,
            youtubeVideoId: "AAAAAAAAAAA",
        };
        const chosen = {
            ...makeTrack("yt:BBBBBBBBBBB", "b"),
            streamSource: "youtube" as const,
            youtubeVideoId: "BBBBBBBBBBB",
        };
        personalizedFeed.current = {
            shelves: {
                quickPicks: [],
                listenAgain: [],
                discovery: [
                    {
                        id: "yt:CCCCCCCCCCC",
                        title: "Stale adaptive",
                        duration: 180,
                        trackNo: null,
                        artist: { name: "C" },
                        album: { title: "C" },
                        source: "youtube",
                        streamSource: "youtube",
                        youtubeVideoId: "CCCCCCCCCCC",
                        provider: {
                            youtubeVideoId: "CCCCCCCCCCC",
                            tidalTrackId: null,
                        },
                    },
                ],
            },
            degraded: false,
            reason: null,
            seedCount: 1,
        };
        const state = createDeferredAudioState({
            queue: [seed],
            currentTrack: seed,
            playbackType: "track",
            vibeMode: true,
        });
        const playback = createPlaybackStub({ currentTime: 34 });
        let release!: () => void;
        personalizedFeedGate.current = new Promise<void>((resolve) => {
            release = resolve;
        });
        const controls = await renderControls({ state, playback });
        const pending = controls.startVibeMode({
            queueStrategy: "replace-upcoming",
        });
        if (action === "replace-queue")
            controls.playTracks([chosen], 0, true, { replaceQueue: true });
        else if (action === "replace-upcoming")
            controls.setUpcoming([chosen], true, true);
        else {
            const { requestRadioQueue } =
                await import("../../lib/radio/radioRequestIntent");
            await requestRadioQueue(async () => []);
        }
        state.commit();
        const selectedQueue = state.queue;
        release();
        const result = await pending;
        state.commit();
        assert.equal(result.success, false);
        assert.equal(state.queue, selectedQueue);
    });
}

for (const action of ["clear", "audiobook", "podcast", "upcoming"] as const) {
    test(
        "collection ownership ends after actual " +
            action +
            " playback replacement",
        async () => {
            const tracks = [
                makeTrack("one", "artist"),
                makeTrack("two", "artist"),
            ];
            const state = createDeferredAudioState({});
            const playback = createPlaybackStub();
            let controls = await renderControls({ state, playback });
            const before = getCollectionPlaybackGeneration();
            controls.playTracks(tracks, 0, false, {
                replaceQueue: true,
                preserveOrder: true,
            });
            markCollectionPlayback("playlist:one", before);
            state.commit();
            assert.equal(isCollectionPlayback("playlist:one"), true);
            controls = await renderControls({ state, playback });
            if (action === "clear") controls.clearQueue();
            if (action === "audiobook")
                controls.playAudiobook({
                    id: "book",
                    title: "Book",
                    author: "Author",
                    coverUrl: null,
                    duration: 600,
                });
            if (action === "podcast")
                controls.playPodcast({
                    id: "podcast:episode",
                    title: "Episode",
                    podcastTitle: "Podcast",
                    coverUrl: null,
                    duration: 600,
                });
            if (action === "upcoming")
                controls.setUpcoming(
                    [makeTrack("radio", "artist")],
                    true,
                    true,
                );
            state.commit();
            assert.equal(isCollectionPlayback("playlist:one"), false);
            controls = await renderControls({ state, playback });
            controls.playNow(makeTrack("other", "artist"));
            state.commit();
            assert.equal(isCollectionPlayback("playlist:one"), false);
        },
    );
}

test("collection ownership survives real next, pause, resume and rejected group starts", async () => {
    const tracks = [makeTrack("one", "artist"), makeTrack("two", "artist")];
    const state = createDeferredAudioState({});
    const playback = createPlaybackStub();
    let controls = await renderControls({ state, playback });
    const before = getCollectionPlaybackGeneration();
    controls.playTracks(tracks, 0, false, {
        replaceQueue: true,
        preserveOrder: true,
    });
    markCollectionPlayback("playlist:one", before);
    state.commit();
    controls = await renderControls({ state, playback });
    controls.next();
    state.commit();
    controls.pause();
    controls.resume();
    assert.equal(isCollectionPlayback("playlist:one"), true);
    listenTogetherSocketMock.hasActiveGroup = true;
    listenTogetherSocketMock.activeGroupId = "group";
    listenTogetherSession.current = {
        groupId: "group",
        isHost: false,
        playback: {
            isPlaying: true,
            positionMs: 0,
            serverTime: Date.now(),
            currentIndex: 0,
        },
    };
    controls.playAudiobook({
        id: "book",
        title: "Book",
        author: "Author",
        coverUrl: null,
        duration: 600,
    });
    assert.equal(isCollectionPlayback("playlist:one"), true);
});

test("fresh playNow records a replacement while queue navigation does not", async () => {
    const state = createDeferredAudioState({});
    const playback = createPlaybackStub();
    const controls = await renderControls({ state, playback });
    const before = getCollectionPlaybackGeneration();
    controls.playNow(makeTrack("fresh", "artist"));
    state.commit();
    assert.ok(getCollectionPlaybackGeneration() > before);
});

test("adversarial finite six skips during trailing GET preserves latest committed taste", async (t) => {
    const { AudioControlsProvider, useAudioControls } =
        await import("../../lib/audio-controls-context");
    const { usePlayEngagementTracking } =
        await import("../../components/player/hooks/usePlayEngagementTracking");
    const { createRoot } = await import("react-dom/client");
    const deferred = () => {
        let release!: () => void;
        const promise = new Promise<void>((r) => {
            release = r;
        });
        return { promise, release };
    };
    const thirdWrite = deferred(),
        firstRead = deferred(),
        trailingResponse = deferred();
    const committed = new Map<string, PlayEngagementInput>();
    const readVersions: number[] = [];
    const providerTrack = (videoId: string) => ({
        ...makeTrack(`yt:${videoId}`, `artist-${videoId}`),
        duration: 200,
        streamSource: "youtube" as const,
        youtubeVideoId: videoId,
        provider: { source: "youtube" as const, youtubeVideoId: videoId },
    });
    const queue = [
        "AAAAAAAAAAA",
        "BBBBBBBBBBB",
        "CCCCCCCCCCC",
        "DDDDDDDDDDD",
        "EEEEEEEEEEE",
        "HHHHHHHHHHH",
        "JJJJJJJJJJJ",
        "KKKKKKKKKKK",
    ].map(providerTrack);
    const state = createDeferredAudioState({
        queue,
        currentTrack: queue[0],
        currentIndex: 0,
        playbackType: "track",
        vibeMode: true,
        vibeQueueIds: queue.map((x) => x.id),
    });
    const playback = createPlaybackStub({ currentTime: 5, duration: 200 });
    playback.isPlaying = true;
    stateHolder.current = state;
    playbackHolder.current = playback;
    apiCalls.personalizedRequests.length = 0;
    engagementWriteImpl.current = async (id, input) => {
        if (id === "play-CCCCCCCCCCC") await thirdWrite.promise;
        committed.set(id, input);
        return { success: true };
    };
    personalizedRequestImpl.current = async () => {
        await firstRead.promise;
        const version = committed.size;
        readVersions.push(version);
        if (readVersions.length === 2) await trailingResponse.promise;
        const id =
            version >= 6
                ? "ZZZZZZZZZZZ"
                : version >= 3
                  ? "GGGGGGGGGGG"
                  : "FFFFFFFFFFF";
        return {
            shelves: {
                discovery: (readVersions.length === 1
                    ? [
                          id,
                          "LLLLLLLLLLL",
                          "MMMMMMMMMMM",
                          "NNNNNNNNNNN",
                          "OOOOOOOOOOO",
                      ]
                    : [id]
                ).map((videoId) => ({
                    ...providerTrack(videoId),
                    source: "youtube",
                    provider: { tidalTrackId: null, youtubeVideoId: videoId },
                })),
                quickPicks: [],
                listenAgain: [],
            },
            degraded: false,
            reason: null,
            seedCount: 1,
        };
    };
    const controlsRef: { current: ReturnType<typeof useAudioControls> | null } =
        { current: null };
    const engineOccurrenceIsCurrent = () => true;
    function MountedPlayer() {
        controlsRef.current = useAudioControls();
        const tracking = usePlayEngagementTracking({
            currentTrack: state.currentTrack as Track,
            currentIndex: state.currentIndex as number,
            localTrackPlaybackOccurrence:
                state.localTrackPlaybackOccurrence as number,
            playbackType: "track",
            isCurrentEngineOccurrence: engineOccurrenceIsCurrent,
            vibeMode: true,
            waveMode: "for-you",
        });
        React.useEffect(() => {
            tracking.noteProgress(0);
            tracking.noteProgress(5);
        }, [tracking.noteProgress]);
        return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => {
        thirdWrite.release();
        firstRead.release();
        trailingResponse.release();
        await React.act(async () => root.unmount());
        container.remove();
    });
    const render = () =>
        React.act(async () => {
            root.render(
                React.createElement(
                    AudioControlsProvider,
                    null,
                    React.createElement(MountedPlayer),
                ),
            );
            await flushAsync();
        });
    await render();
    for (let n = 0; n < 3; n++) {
        playback.currentTime = 5;
        controlsRef.current!.advanceQueue("manual");
        state.commit();
        await render();
    }
    assert.equal(committed.size, 2);
    assert.equal(apiCalls.personalizedRequests.length, 1);
    await React.act(async () => {
        firstRead.release();
        await flushAsync();
    });
    state.commit();
    await render();
    await React.act(async () => {
        thirdWrite.release();
        await flushAsync();
    });
    assert.deepEqual(readVersions, [2, 3]);
    assert.equal(apiCalls.personalizedRequests.length, 2);
    // A second finite triple lands after the trailing read but before its response commits.
    for (let n = 0; n < 3; n++) {
        playback.currentTime = 5;
        controlsRef.current!.advanceQueue("manual");
        state.commit();
        await render();
    }
    assert.equal(committed.size, 6);
    const selected = state.currentTrack;
    playback.currentTime = 9;
    controlsRef.current!.pause();
    await React.act(async () => {
        trailingResponse.release();
        await flushAsync();
    });
    state.commit();
    await render();
    await React.act(flushAsync);
    state.commit();
    await render();
    const proof = {
        committed: committed.size,
        readVersions,
        requests: apiCalls.personalizedRequests.length,
        tail: (state.queue as Track[]).at(-1)?.id,
        current: (state.currentTrack as Track).id,
        position: playback.currentTime,
        isPlaying: playback.isPlaying,
    };
    console.log("FINITE_BURST_PROOF " + JSON.stringify(proof));
    assert.equal(state.currentTrack, selected);
    assert.equal(playback.currentTime, 9);
    assert.equal(playback.isPlaying, false);
    assert.equal(
        (state.queue as Track[]).at(-1)?.id,
        "yt:ZZZZZZZZZZZ",
        "finite second triple must eventually get a fresh continuation after all six server ACKs",
    );
});

test("explicit manual add strips smart insertion lineage without mutating the original occurrence", async () => {
    const selected = makeTrack("current", "artist-1");
    const state = createDeferredAudioState({
        queue: [selected],
        currentIndex: 0,
        currentTrack: selected,
        playbackType: "track",
    });
    const playback = createPlaybackStub({ currentTime: 23, duration: 200 });
    const controls = await renderControls({ state, playback });
    const discovery: Track = {
        ...makeTrack("chosen", "artist-2"),
        recommendationSessionId: "smart-shuffle:session-1",
        recommendationQueueMode: "finite",
        smartShuffle: {
            v: 1,
            sessionId: "session-1",
            playlistId: "playlist-1",
            seed: 1,
            snapshotId: "12345678",
            kind: "injected",
            occurrenceId: "injected:session-1:0",
            cursor: 1,
            enabled: true,
        },
    };
    controls.addToQueue(discovery, { silent: true });
    state.commit();
    const added = (state.queue as Track[]).at(-1)!;
    assert.equal(added.id, "chosen");
    assert.equal(added.smartShuffle, undefined);
    assert.equal(added.recommendationSessionId, undefined);
    assert.equal(discovery.smartShuffle?.kind, "injected");
    assert.equal(state.currentTrack, selected);
    assert.equal(playback.currentTime, 23);
});

test("finite smart next/back keeps duplicate item occurrences and never refills a finished pool", async () => {
    const { buildSmartShuffleQueue } =
        await import("../../lib/audio/finiteSmartShuffle");
    const tracks = buildSmartShuffleQueue(
        [
            { ...makeTrack("same", "artist-1"), playlistItemId: "item-1" },
            { ...makeTrack("same", "artist-1"), playlistItemId: "item-2" },
            { ...makeTrack("third", "artist-2"), playlistItemId: "item-3" },
        ],
        [makeTrack("found", "artist-3")],
        { playlistId: "playlist-1", sessionId: "session-1", seed: 1 },
    );
    const state = createDeferredAudioState({});
    const playback = createPlaybackStub({ currentTime: 0, duration: 200 });
    let controls = await renderControls({ state, playback });
    controls.playTracks(tracks, 0, false, {
        replaceQueue: true,
        preserveOrder: true,
    });
    state.commit();
    assert.equal(state.vibeMode, false);
    controls = await renderControls({ state, playback });
    controls.next();
    state.commit();
    assert.equal((state.currentTrack as Track).playlistItemId, "item-2");
    controls = await renderControls({ state, playback });
    controls.next();
    state.commit();
    controls = await renderControls({ state, playback });
    controls.next();
    state.commit();
    assert.equal((state.currentTrack as Track).id, "found");
    controls = await renderControls({ state, playback });
    controls.previous();
    state.commit();
    assert.equal((state.currentTrack as Track).playlistItemId, "item-3");
    controls = await renderControls({ state, playback });
    controls.next();
    state.commit();
    const requests = apiCalls.personalizedRequests.length;
    controls = await renderControls({ state, playback });
    controls.next();
    await flushAsync();
    state.commit();
    assert.equal(state.currentIndex, 3);
    assert.equal((state.queue as Track[]).length, 4);
    assert.equal(apiCalls.personalizedRequests.length, requests);
});
