import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import ReactDefault from "react";

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

type Effect = () => void | (() => void);

class HookLifecycleHarness {
    private hookIndex = 0;
    private readonly refs: Array<{ current: unknown }> = [];
    private pendingLayoutEffects: Effect[] = [];
    private pendingPassiveEffects: Effect[] = [];

    beginRender() {
        this.hookIndex = 0;
        this.pendingLayoutEffects = [];
        this.pendingPassiveEffects = [];
    }

    commitRender() {
        activeHarness = null;
        const effects = this.pendingLayoutEffects;
        this.pendingLayoutEffects = [];
        effects.forEach((effect) => effect());
    }

    flushPassiveEffects() {
        const effects = this.pendingPassiveEffects;
        this.pendingPassiveEffects = [];
        effects.forEach((effect) => effect());
    }

    useRef<T>(initialValue: T): { current: T } {
        const index = this.hookIndex++;
        this.refs[index] ??= { current: initialValue };
        return this.refs[index] as { current: T };
    }

    useLayoutEffect(effect: Effect) {
        this.hookIndex++;
        this.pendingLayoutEffects.push(effect);
    }

    useEffect(effect: Effect) {
        this.hookIndex++;
        this.pendingPassiveEffects.push(effect);
    }

    useCallback<T>(callback: T): T {
        this.hookIndex++;
        return callback;
    }
}

let activeHarness: HookLifecycleHarness | null = null;

function requireActiveHarness(): HookLifecycleHarness {
    assert.ok(activeHarness, "hook rendered outside its lifecycle harness");
    return activeHarness;
}

mock.module("react", {
    defaultExport: ReactDefault,
    namedExports: {
        useCallback: <T>(callback: T) =>
            requireActiveHarness().useCallback(callback),
        useEffect: (effect: Effect) => requireActiveHarness().useEffect(effect),
        useLayoutEffect: (effect: Effect) =>
            requireActiveHarness().useLayoutEffect(effect),
        useRef: <T>(initialValue: T) =>
            requireActiveHarness().useRef(initialValue),
    },
});

const feedRequests: Array<Deferred<Record<string, unknown>>> = [];
const feedRequestPaths: string[] = [];
const feedRequestOptions: Array<
    { timeoutMs?: number; retryOnTimeout?: boolean } | undefined
> = [];

mock.module("@/lib/api", {
    namedExports: {
        api: {
            request: (
                path: string,
                options?: { timeoutMs?: number; retryOnTimeout?: boolean },
            ) => {
                const request = deferred<Record<string, unknown>>();
                feedRequests.push(request);
                feedRequestPaths.push(path);
                feedRequestOptions.push(options);
                return request.promise;
            },
            getVibeSimilarTracks: async () => ({
                tracks: [],
                sourceFeatures: null,
            }),
        },
    },
});

mock.module("@/lib/listen-together-socket", {
    namedExports: {
        listenTogetherSocket: {
            addToQueue: async () => ({
                acceptedCount: 0,
                skippedCount: 0,
                truncated: false,
            }),
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: { error: () => undefined },
    },
});

mock.module("sonner", {
    namedExports: {
        toast: { info: () => undefined, error: () => undefined },
    },
});

beforeEach(() => {
    feedRequests.length = 0;
    feedRequestPaths.length = 0;
    feedRequestOptions.length = 0;
    activeHarness = null;
});

function makeProviderTrack(videoId: string) {
    return {
        id: `yt:${videoId}`,
        title: `Track ${videoId}`,
        duration: 180,
        artist: { id: null, name: "Artist" },
        album: { id: null, title: "Album" },
        streamSource: "youtube" as const,
        youtubeVideoId: videoId,
        provider: { source: "youtube" as const, youtubeVideoId: videoId },
    };
}

function makeAudioState(
    track: ReturnType<typeof makeProviderTrack>,
    queue: ReturnType<typeof makeProviderTrack>[] = [track],
    currentIndex = 0,
    vibeMode = false,
    waveMode: "for-you" | "new" | "familiar" = "for-you",
    waveMood:
        | "calm"
        | "energetic"
        | "focus"
        | "workout"
        | "favorites"
        | "forgotten"
        | null = null,
) {
    const mutations: string[] = [];
    return {
        state: {
            currentTrack: track,
            currentIndex,
            queue,
            vibeMode,
            waveMode,
            waveMood,
            setIsShuffle: () => mutations.push("shuffle"),
            setShuffleIndices: () => mutations.push("shuffle-indices"),
            setVibeMode: () => mutations.push("vibe-mode"),
            setVibeSourceFeatures: () => mutations.push("vibe-features"),
            setVibeQueueIds: () => mutations.push("vibe-ids"),
            setQueue: () => mutations.push("queue"),
            setCurrentIndex: () => mutations.push("index"),
        },
        mutations,
    };
}

test("provider continuation keeps the active Wave mood outside the Vibe route", async () => {
    const { useVibeModeControls } =
        await import("../../lib/audio/useVibeModeControls");
    const harness = new HookLifecycleHarness();
    const seed = makeProviderTrack("AAAAAAAAAAA");
    const audio = makeAudioState(seed, [seed], 0, true, "new", "workout");

    harness.beginRender();
    activeHarness = harness;
    const controls = useVibeModeControls({
        state: audio.state as never,
        getActiveListenTogetherSession: () => null,
        showQueueMutationToasts: () => undefined,
    });
    harness.commitRender();

    const result = controls.startVibeMode();
    await Promise.resolve();
    const requestUrl = new URL(feedRequestPaths[0], "https://soundspan.test");
    assert.equal(requestUrl.searchParams.get("mode"), "new");
    assert.equal(requestUrl.searchParams.get("mood"), "workout");

    feedRequests[0].resolve({
        shelves: {
            discovery: [makeProviderTrack("BBBBBBBBBBB")],
            quickPicks: [],
            listenAgain: [],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
        nextCursor: 1,
    });
    assert.deepEqual(await result, { success: true, trackCount: 1 });
});

test("provider radio advances its cursor and sends the bounded queue exclusions on continuation", async () => {
    const { useVibeModeControls } =
        await import("../../lib/audio/useVibeModeControls");
    const harness = new HookLifecycleHarness();
    const seed = makeProviderTrack("AAAAAAAAAAA");
    const firstFresh = makeProviderTrack("BBBBBBBBBBB");
    const initial = makeAudioState(seed, [seed], 0, false, "familiar");
    const continued = makeAudioState(
        seed,
        [seed, firstFresh],
        0,
        true,
        "familiar",
    );

    function HookProbe(audioState: typeof initial.state) {
        harness.beginRender();
        activeHarness = harness;
        const controls = useVibeModeControls({
            state: audioState as never,
            getActiveListenTogetherSession: () => null,
            showQueueMutationToasts: () => undefined,
        });
        harness.commitRender();
        return controls;
    }

    const initialControls = HookProbe(initial.state);
    const firstResult = initialControls.startVibeMode();
    await Promise.resolve();
    feedRequests[0].resolve({
        shelves: {
            discovery: [firstFresh],
            quickPicks: [],
            listenAgain: [],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
        nextCursor: 4,
    });
    assert.deepEqual(await firstResult, { success: true, trackCount: 1 });

    const continuedControls = HookProbe(continued.state);
    const secondResult = continuedControls.startVibeMode();
    await Promise.resolve();
    const secondUrl = new URL(feedRequestPaths[1], "https://soundspan.test");
    assert.equal(secondUrl.searchParams.get("cursor"), "4");
    assert.equal(secondUrl.searchParams.get("mode"), "familiar");
    assert.deepEqual(secondUrl.searchParams.get("exclude")?.split(","), [
        "AAAAAAAAAAA",
        "BBBBBBBBBBB",
    ]);

    feedRequests[1].resolve({
        shelves: {
            discovery: [makeProviderTrack("CCCCCCCCCCC")],
            quickPicks: [],
            listenAgain: [],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
        nextCursor: 5,
    });
    assert.deepEqual(await secondResult, { success: true, trackCount: 1 });
});

test("provider radio advances to another seed page when the first continuation only repeats queued tracks", async () => {
    const { useVibeModeControls } =
        await import("../../lib/audio/useVibeModeControls");
    const harness = new HookLifecycleHarness();
    const seed = makeProviderTrack("AAAAAAAAAAA");
    const audio = makeAudioState(seed, [seed], 0, true);

    harness.beginRender();
    activeHarness = harness;
    const controls = useVibeModeControls({
        state: audio.state as never,
        getActiveListenTogetherSession: () => null,
        showQueueMutationToasts: () => undefined,
    });
    harness.commitRender();

    const result = controls.startVibeMode();
    await Promise.resolve();
    feedRequests[0].resolve({
        shelves: {
            discovery: [seed],
            quickPicks: [],
            listenAgain: [],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
        nextCursor: 1,
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(feedRequests.length, 2);
    assert.deepEqual(feedRequestOptions, [
        { timeoutMs: 17_000, retryOnTimeout: false },
        { timeoutMs: 17_000, retryOnTimeout: false },
    ]);
    assert.equal(
        new URL(feedRequestPaths[1], "https://soundspan.test").searchParams.get(
            "cursor",
        ),
        "1",
    );
    feedRequests[1].resolve({
        shelves: {
            discovery: [makeProviderTrack("BBBBBBBBBBB")],
            quickPicks: [],
            listenAgain: [],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
        nextCursor: 2,
    });

    assert.deepEqual(await result, { success: true, trackCount: 1 });
});

test("manual duplicate selection is committed before a matching Vibe token can escape", async () => {
    const { useVibeModeControls } =
        await import("../../lib/audio/useVibeModeControls");
    const harness = new HookLifecycleHarness();
    const earlierDuplicate = makeProviderTrack("AAAAAAAAAAA");
    const endingDuplicate = makeProviderTrack("AAAAAAAAAAA");
    const middle = makeProviderTrack("CCCCCCCCCCC");
    const original = makeAudioState(
        endingDuplicate,
        [earlierDuplicate, middle, endingDuplicate],
        2,
    );
    const manuallySelected = makeAudioState(
        earlierDuplicate,
        [earlierDuplicate, middle, endingDuplicate],
        0,
    );

    function HookProbe(audioState: typeof original.state) {
        harness.beginRender();
        activeHarness = harness;
        const controls = useVibeModeControls({
            state: audioState as never,
            getActiveListenTogetherSession: () => null,
            showQueueMutationToasts: () => undefined,
        });
        harness.commitRender();
        return controls;
    }

    const initialControls = HookProbe(original.state);
    harness.flushPassiveEffects();

    const queueCommitToken = {};
    const queueCommits: unknown[] = [];
    const pendingResult = initialControls.startVibeMode({
        queueCommitToken,
        onLocalQueueCommit: (commit) => queueCommits.push(commit),
    });
    await Promise.resolve();
    assert.equal(feedRequests.length, 1);

    HookProbe(manuallySelected.state);
    // Resolve in the post-commit/pre-passive gap. Only a layout-synchronous
    // playback-context fence can reject this otherwise-valid request token.
    feedRequests[0].resolve({
        shelves: {
            discovery: [makeProviderTrack("BBBBBBBBBBB")],
            quickPicks: [],
            listenAgain: [],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    });
    const result = await pendingResult;

    assert.deepEqual(result, { success: false, trackCount: 0 });
    assert.deepEqual(queueCommits, []);
    assert.deepEqual(original.mutations, []);
    assert.deepEqual(manuallySelected.mutations, []);
});

test("late provider radio response is ignored after the active track changes", async () => {
    const { useVibeModeControls } =
        await import("../../lib/audio/useVibeModeControls");
    const harness = new HookLifecycleHarness();
    const first = makeAudioState(makeProviderTrack("AAAAAAAAAAA"));
    const second = makeAudioState(makeProviderTrack("CCCCCCCCCCC"));

    function HookProbe(audioState: typeof first.state) {
        harness.beginRender();
        activeHarness = harness;
        const controls = useVibeModeControls({
            state: audioState as never,
            getActiveListenTogetherSession: () => null,
            showQueueMutationToasts: () => undefined,
        });
        harness.commitRender();
        return controls;
    }

    const initialControls = HookProbe(first.state);
    harness.flushPassiveEffects();
    const pendingResult = initialControls.startVibeMode();
    await Promise.resolve();
    assert.equal(feedRequests.length, 1);

    HookProbe(second.state);
    harness.flushPassiveEffects();
    feedRequests[0].resolve({
        shelves: {
            discovery: [makeProviderTrack("BBBBBBBBBBB")],
            quickPicks: [],
            listenAgain: [],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    });
    const result = await pendingResult;

    assert.deepEqual(result, { success: false, trackCount: 0 });
    assert.deepEqual(first.mutations, []);
    assert.deepEqual(second.mutations, []);
});
