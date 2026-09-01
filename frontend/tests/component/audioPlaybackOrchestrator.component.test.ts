import assert from "node:assert/strict";
import * as realPlaybackRecoveryPolicy from "../../lib/audio-engine/playbackRecoveryPolicy";
import {
    isPlaybackAutoRestartSuppressed,
    markRemoteTrackChange,
    setPlaybackAutoRestartSuppressed,
    writePlaybackAdvanceOrigin,
    writePlaybackReplacementIntent,
} from "../../lib/audio-engine/playbackAdvanceOrigin";
import { afterEach, before, beforeEach, mock, test } from "node:test";
import type {
    VibeModeStartOptions,
    VibeModeStartResult,
    VibeQueueMutationKind,
} from "../../lib/audio-controls-types";
import {
    clearDeviceOfflineRuntimeState,
    prepareDeviceOfflinePlaybackSource,
    setDeviceOfflineRuntimeState,
} from "../../features/device-offline/playbackResolver";
import type { DeviceOfflineDownloadRecord } from "../../features/device-offline/types";
import {
    DeviceAudioVaultError,
    installDeviceAudioVaultFactory,
    type DeviceAudioPlayResult,
    type DeviceAudioVault,
    type DeviceAudioVaultRef,
    type DeviceAudioVaultSession,
} from "../../features/device-offline/vault";
import {
    clearPlaybackHeartbeat,
    hasFreshPlaybackHeartbeat,
} from "../../lib/audio/playback-liveness";

type PlaybackType = "track" | "audiobook" | "podcast" | null;

type Track = {
    id: string;
    title: string;
    duration?: number;
    filePath?: string;
    streamSource?: "local" | "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    playlistItemId?: string;
    trackYtMusicId?: string;
    artist?: { name?: string };
    album?: { title?: string };
    displayTitle?: string;
    mediaSource?: unknown;
    provider?: {
        source?: "local" | "tidal" | "youtube" | "youtube-direct";
        providerTrackId?: string;
        tidalTrackId?: number;
        youtubeVideoId?: string;
    };
};

type Podcast = {
    id: string;
    title?: string;
    podcastTitle?: string;
    duration?: number;
    progress?: { currentTime?: number };
};

type Audiobook = {
    id: string;
    duration?: number;
    progress?: { currentTime?: number };
};

class FakeAudioEngine {
    public readonly loadCalls: Array<{ args: unknown[] }> = [];
    public readonly onCalls: Array<{ event: string }> = [];
    public readonly offCalls: Array<{ event: string }> = [];
    public readonly seekCalls: number[] = [];
    public readonly setVolumeCalls: number[] = [];
    public readonly setMutedCalls: boolean[] = [];
    public readonly preloadCalls: Array<{ url: string; format: string }> = [];

    public playCalls = 0;
    public pauseCalls = 0;
    public stopCalls = 0;
    public reloadCalls = 0;
    public notifyTrackEndedCalls = 0;

    public currentTime = 0;
    public actualCurrentTime = 0;
    public duration = 240;
    public playing = false;
    public trackEnded = false;

    private handlers = new Map<string, Set<(payload?: unknown) => void>>();

    reset(): void {
        this.loadCalls.length = 0;
        this.onCalls.length = 0;
        this.offCalls.length = 0;
        this.seekCalls.length = 0;
        this.setVolumeCalls.length = 0;
        this.setMutedCalls.length = 0;
        this.preloadCalls.length = 0;
        this.playCalls = 0;
        this.pauseCalls = 0;
        this.stopCalls = 0;
        this.reloadCalls = 0;
        this.notifyTrackEndedCalls = 0;
        this.currentTime = 0;
        this.actualCurrentTime = 0;
        this.duration = 240;
        this.playing = false;
        this.trackEnded = false;
        this.handlers.clear();
    }

    emit(event: string, payload?: unknown): void {
        const listeners = this.handlers.get(event);
        if (!listeners) return;
        for (const handler of listeners) {
            handler(payload);
        }
    }

    load(...args: unknown[]): void {
        this.loadCalls.push({ args });
    }

    play(): void {
        this.playing = true;
        this.playCalls += 1;
    }

    pause(): void {
        this.playing = false;
        this.pauseCalls += 1;
    }

    stop(): void {
        this.playing = false;
        this.stopCalls += 1;
    }

    seek(timeSec: number): void {
        this.currentTime = timeSec;
        this.actualCurrentTime = timeSec;
        this.seekCalls.push(timeSec);
    }

    reload(): void {
        this.reloadCalls += 1;
    }

    preload(url: string, format: string): void {
        this.preloadCalls.push({ url, format });
    }

    setVolume(value: number): void {
        this.setVolumeCalls.push(value);
    }

    setMuted(value: boolean): void {
        this.setMutedCalls.push(Boolean(value));
    }

    getCurrentTime(): number {
        return this.currentTime;
    }

    getActualCurrentTime(): number {
        return this.actualCurrentTime;
    }

    getDuration(): number {
        return this.duration;
    }

    isPlaying(): boolean {
        return this.playing;
    }

    hasTrackEnded(): boolean {
        return this.trackEnded;
    }

    notifyTrackEnded(): void {
        this.notifyTrackEndedCalls += 1;
    }

    // Mirrors HybridRuntimeAudioEngine.getActiveEngineDescriptor() (GH #42
    // native-engine soak): this fake has one slot, so it keys off the same
    // runtimeEngineMode the engineMode mock uses.
    getActiveEngineDescriptor(): "howler" | "native" {
        return runtimeEngineMode === "native" ? "native" : "howler";
    }

    on(event: string, handler: (payload?: unknown) => void): void {
        let listeners = this.handlers.get(event);
        if (!listeners) {
            listeners = new Set();
            this.handlers.set(event, listeners);
        }
        listeners.add(handler);
        this.onCalls.push({ event });
    }

    off(event: string, handler: (payload?: unknown) => void): void {
        this.handlers.get(event)?.delete(handler);
        this.offCalls.push({ event });
    }

    destroy(): void {
        this.handlers.clear();
    }
}

type EffectCallback = () => void | (() => void);

type HookSlot =
    | { kind: "ref"; value: { current: unknown } }
    | {
          kind: "callback";
          deps: readonly unknown[] | undefined;
          fn: (...args: unknown[]) => unknown;
      }
    | {
          kind: "effect" | "layout";
          deps: readonly unknown[] | undefined;
          cleanup: (() => void) | null;
      };

class HookRuntime {
    private slots: HookSlot[] = [];
    private cursor = 0;
    private pendingLayouts: Array<{
        index: number;
        callback: EffectCallback;
        deps: readonly unknown[] | undefined;
    }> = [];
    private pendingEffects: Array<{
        index: number;
        callback: EffectCallback;
        deps: readonly unknown[] | undefined;
    }> = [];

    render(component: () => unknown): void {
        this.cursor = 0;
        this.pendingLayouts = [];
        this.pendingEffects = [];

        component();

        this.flush(this.pendingLayouts, "layout");
        this.flush(this.pendingEffects, "effect");
    }

    unmount(): void {
        for (const slot of this.slots) {
            if (
                (slot.kind === "effect" || slot.kind === "layout") &&
                slot.cleanup
            ) {
                slot.cleanup();
                slot.cleanup = null;
            }
        }
        this.slots = [];
        this.cursor = 0;
        this.pendingLayouts = [];
        this.pendingEffects = [];
    }

    useRef<T>(initialValue: T): { current: T } {
        const index = this.cursor;
        this.cursor += 1;

        const slot = this.slots[index];
        if (!slot) {
            const value = { current: initialValue };
            this.slots[index] = { kind: "ref", value };
            return value;
        }
        assert.equal(slot.kind, "ref");
        return slot.value as { current: T };
    }

    useCallback<T extends (...args: unknown[]) => unknown>(
        fn: T,
        deps: readonly unknown[] | undefined,
    ): T {
        const index = this.cursor;
        this.cursor += 1;

        const slot = this.slots[index];
        if (!slot) {
            this.slots[index] = { kind: "callback", deps, fn };
            return fn;
        }

        assert.equal(slot.kind, "callback");
        if (!areDepsEqual(slot.deps, deps)) {
            slot.deps = deps;
            slot.fn = fn;
        }
        return slot.fn as T;
    }

    useEffect(
        callback: EffectCallback,
        deps: readonly unknown[] | undefined,
    ): void {
        this.registerEffect("effect", callback, deps);
    }

    useLayoutEffect(
        callback: EffectCallback,
        deps: readonly unknown[] | undefined,
    ): void {
        this.registerEffect("layout", callback, deps);
    }

    private registerEffect(
        kind: "effect" | "layout",
        callback: EffectCallback,
        deps: readonly unknown[] | undefined,
    ): void {
        const index = this.cursor;
        this.cursor += 1;

        const slot = this.slots[index];
        if (!slot) {
            this.slots[index] = { kind, deps, cleanup: null };
            this.enqueue(kind, index, callback, deps);
            return;
        }

        assert.equal(slot.kind, kind);
        if (!areDepsEqual(slot.deps, deps)) {
            this.enqueue(kind, index, callback, deps);
        }
    }

    private enqueue(
        kind: "effect" | "layout",
        index: number,
        callback: EffectCallback,
        deps: readonly unknown[] | undefined,
    ): void {
        const queue =
            kind === "layout" ? this.pendingLayouts : this.pendingEffects;
        queue.push({ index, callback, deps });
    }

    private flush(
        queue: Array<{
            index: number;
            callback: EffectCallback;
            deps: readonly unknown[] | undefined;
        }>,
        expectedKind: "effect" | "layout",
    ): void {
        for (const entry of queue) {
            const slot = this.slots[entry.index];
            assert.ok(
                slot && (slot.kind === "effect" || slot.kind === "layout"),
            );
            assert.equal(slot.kind, expectedKind);
            if (slot.cleanup) {
                slot.cleanup();
                slot.cleanup = null;
            }
            const cleanup = entry.callback();
            slot.deps = entry.deps;
            slot.cleanup = typeof cleanup === "function" ? cleanup : null;
        }
    }
}

const areDepsEqual = (
    previous: readonly unknown[] | undefined,
    next: readonly unknown[] | undefined,
): boolean => {
    if (!previous || !next) return false;
    if (previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index += 1) {
        if (!Object.is(previous[index], next[index])) return false;
    }
    return true;
};

const hookRuntime = new HookRuntime();
const engine = new FakeAudioEngine();

const seekSubscribers = new Set<(time: number) => void | Promise<void>>();
const emitSeek = (time: number): void => {
    for (const handler of seekSubscribers) {
        void handler(time);
    }
};

const audioState = {
    currentTrack: null as Track | null,
    currentAudiobook: null as Audiobook | null,
    currentPodcast: null as Podcast | null,
    playbackType: "track" as PlaybackType,
    volume: 0.8,
    isMuted: false,
    repeatMode: "off" as "off" | "one" | "all",
    queue: [] as Track[],
    currentIndex: 0,
    isShuffle: false,
    shuffleIndices: [] as number[],
    vibeMode: false,
    waveMode: "for-you" as "for-you" | "new" | "familiar",
};

const playbackState = {
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    isBuffering: false,
    canSeek: true,
};

const playbackCalls = {
    setCurrentTime: [] as number[],
    setCurrentTimeFromEngine: [] as number[],
    setDuration: [] as number[],
    setIsPlaying: [] as boolean[],
    setIsBuffering: [] as boolean[],
    setTargetSeekPosition: [] as Array<number | null>,
    setCanSeek: [] as boolean[],
    setDownloadProgress: [] as Array<number | null>,
    setStreamProfile: [] as Array<unknown>,
};

const audioStateSetterCalls = {
    setCurrentTrack: [] as Array<Track | null>,
    setCurrentAudiobook: [] as Array<Audiobook | null>,
    setCurrentPodcast: [] as Array<Podcast | null>,
    setPlaybackType: [] as Array<PlaybackType>,
    setQueue: [] as Track[][],
};

const controlCalls = {
    pause: 0,
    next: 0,
    nextPodcastEpisode: 0,
    startVibeMode: 0,
};

const apiCalls = {
    getStreamUrl: [] as string[],
    getPodcastEpisodeCacheStatus: [] as Array<{
        podcastId: string;
        episodeId: string;
    }>,
    updatePodcastProgress: [] as Array<{
        podcastId: string;
        episodeId: string;
        positionSec: number;
        durationSec: number;
        isFinished: boolean;
    }>,
    reportPlaybackClientMetric: [] as Array<Record<string, unknown>>,
    recoverUnavailableYtMusicTrack: [] as Array<Record<string, unknown>>,
    logPlay: [] as Array<{
        trackRef: Record<string, unknown>;
        context: Record<string, unknown>;
    }>,
    updatePlayEngagement: [] as Array<{
        playId: string;
        input: Record<string, unknown>;
    }>,
};

const preemptChecks: Array<{
    currentMediaId: string | null;
    previousMediaId: string | null;
    isLoading: boolean;
}> = [];

const toastErrors: string[] = [];
const listenTogetherHostTrackOperations: string[] = [];
const listenTogetherResyncCalls: string[] = [];
const migratingStorageItems = new Map<string, string>();

let runtimeEngineMode: "howler" | "native" = "howler";
let listenTogetherSnapshot: {
    groupId?: string;
    isHost?: boolean;
} | null = null;
let podcastCacheStatus = {
    cached: true,
    downloading: false,
    downloadProgress: null as number | null,
};
let seekToleranceOverride: boolean | null = null;
let mirrorMachineIntentToPlaybackState = false;
let startVibeModeImpl: (
    options?: VibeModeStartOptions,
) => Promise<VibeModeStartResult> = async () => ({
    success: false,
    trackCount: 0,
});
let advanceQueueRequiresCapturedNext = false;
let recoverUnavailableYtMusicTrackImpl: (
    input: Record<string, unknown>,
) => Promise<Record<string, unknown>> = async () => {
    throw new Error("unavailable recovery disabled in harness");
};
const loggerCalls = {
    info: [] as Array<unknown[]>,
    warn: [] as Array<unknown[]>,
    error: [] as Array<unknown[]>,
};

class FakeVisibilityDocument {
    public visibilityState: "hidden" | "visible" = "visible";
    private readonly listeners = new Set<() => void>();

    addEventListener(event: string, listener: () => void): void {
        if (event === "visibilitychange") {
            this.listeners.add(listener);
        }
    }

    removeEventListener(event: string, listener: () => void): void {
        if (event === "visibilitychange") {
            this.listeners.delete(listener);
        }
    }

    dispatchVisibility(state: "hidden" | "visible"): void {
        this.visibilityState = state;
        for (const listener of this.listeners) {
            listener();
        }
    }
}

const installVisibilityDocument = (): FakeVisibilityDocument => {
    const fakeDocument = new FakeVisibilityDocument();
    (globalThis as unknown as { document: FakeVisibilityDocument }).document =
        fakeDocument;
    return fakeDocument;
};

const makeTrack = (id: string, overrides: Partial<Track> = {}): Track => ({
    id,
    title: `Track ${id}`,
    duration: 210,
    filePath: `${id}.mp3`,
    streamSource: "local",
    ...overrides,
});

const fakeDeviceAudioVault = (
    open: DeviceAudioVault["open"],
): DeviceAudioVault => ({
    inspectAccess: async () => ({
        status: "ready",
        code: null,
        storageKind: "desktop-directory",
        label: "Test music",
        reason: "Ready",
    }),
    requestAccess: async () => ({
        status: "ready",
        code: null,
        storageKind: "desktop-directory",
        label: "Test music",
        reason: "Ready",
    }),
    open,
});

const deferred = <T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
} => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

const managedReadyRecord = (
    ownerId: string,
    key: string,
    track: Track,
    mediaRef: DeviceAudioVaultRef,
): DeviceOfflineDownloadRecord =>
    ({
        key,
        ownerId,
        trackIdentity: `youtube:${track.youtubeVideoId ?? track.id}`,
        quality: "auto",
        virtualUrl: `/__offline/audio/${key}`,
        sourceUrl: `/api/ytmusic/stream-public/${track.youtubeVideoId ?? track.id}`,
        track,
        status: "ready",
        transferMode: "foreground",
        backgroundFetchId: null,
        bytesReceived: 6,
        totalBytes: 6,
        contentType: "audio/mp4",
        persistenceGranted: true,
        attempt: 1,
        createdAt: 1,
        updatedAt: 1,
        errorCode: null,
        errorMessage: null,
        mediaRef,
    }) as DeviceOfflineDownloadRecord;

const resetHarnessState = (): void => {
    clearDeviceOfflineRuntimeState();
    engine.reset();
    hookRuntime.unmount();
    heartbeatInstances.length = 0;

    audioState.currentTrack = makeTrack("track-1");
    audioState.currentAudiobook = null;
    audioState.currentPodcast = null;
    audioState.playbackType = "track";
    audioState.volume = 0.8;
    audioState.isMuted = false;
    audioState.repeatMode = "off";
    audioState.queue = [audioState.currentTrack, makeTrack("track-2")];
    audioState.currentIndex = 0;
    audioState.isShuffle = false;
    audioState.shuffleIndices = [0, 1];
    audioState.vibeMode = false;
    audioState.waveMode = "for-you";

    playbackState.isPlaying = false;
    playbackState.currentTime = 0;
    playbackState.duration = 0;
    playbackState.isBuffering = false;
    playbackState.canSeek = true;

    for (const values of Object.values(playbackCalls)) {
        values.length = 0;
    }
    for (const values of Object.values(audioStateSetterCalls)) {
        values.length = 0;
    }

    controlCalls.pause = 0;
    controlCalls.next = 0;
    controlCalls.nextPodcastEpisode = 0;
    controlCalls.startVibeMode = 0;

    for (const values of Object.values(apiCalls)) {
        values.length = 0;
    }
    preemptChecks.length = 0;
    toastErrors.length = 0;
    listenTogetherHostTrackOperations.length = 0;
    listenTogetherResyncCalls.length = 0;
    migratingStorageItems.clear();

    runtimeEngineMode = "howler";
    listenTogetherSnapshot = null;
    writePlaybackAdvanceOrigin(null, null);
    setPlaybackAutoRestartSuppressed(false);
    podcastCacheStatus = {
        cached: true,
        downloading: false,
        downloadProgress: null,
    };
    seekToleranceOverride = null;
    mirrorMachineIntentToPlaybackState = false;
    startVibeModeImpl = async () => ({ success: false, trackCount: 0 });
    advanceQueueRequiresCapturedNext = false;
    recoverUnavailableYtMusicTrackImpl = async () => {
        throw new Error("unavailable recovery disabled in harness");
    };
    loggerCalls.info.length = 0;
    loggerCalls.warn.length = 0;
    loggerCalls.error.length = 0;
    seekSubscribers.clear();
};

const applyValue = <T>(incoming: T | ((previous: T) => T), previous: T): T => {
    if (typeof incoming === "function") {
        return (incoming as (value: T) => T)(previous);
    }
    return incoming;
};

const reactMock = {
    createElement: (..._args: unknown[]) => ({ __mocked: true }),
    createContext: <T>(defaultValue: T) => ({
        __defaultValue: defaultValue,
    }),
    useContext: (context: { __defaultValue: unknown } | null) =>
        context?.__defaultValue ?? {
            prefetchQuery: async () => undefined,
        },
    useRef: <T>(value: T) => hookRuntime.useRef(value),
    useCallback: <T extends (...args: unknown[]) => unknown>(
        fn: T,
        deps?: readonly unknown[],
    ) => hookRuntime.useCallback(fn, deps),
    useEffect: (effect: EffectCallback, deps?: readonly unknown[]) =>
        hookRuntime.useEffect(effect, deps),
    useLayoutEffect: (effect: EffectCallback, deps?: readonly unknown[]) =>
        hookRuntime.useLayoutEffect(effect, deps),
    useState: <T>(initial: T | (() => T)) => [
        typeof initial === "function" ? (initial as () => T)() : initial,
        () => undefined,
    ],
    useMemo: <T>(factory: () => T) => factory(),
    memo: <T>(component: T) => component,
    forwardRef: <T>(render: T) => render,
    Fragment: "mock-fragment",
};

mock.module("react", {
    defaultExport: reactMock,
    namedExports: reactMock,
});

mock.module("react/jsx-runtime", {
    namedExports: {
        Fragment: "mock-fragment",
        jsx: (..._args: unknown[]) => ({ __mocked: true }),
        jsxs: (..._args: unknown[]) => ({ __mocked: true }),
    },
});

mock.module("@/components/player/PlaybackProgressSnapshot", {
    namedExports: {
        PlaybackProgressSnapshot: () => null,
    },
});

mock.module("@/lib/audio-engine", {
    namedExports: {
        createRuntimeAudioEngine: () => engine,
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: audioState.currentTrack,
            currentAudiobook: audioState.currentAudiobook,
            currentPodcast: audioState.currentPodcast,
            playbackType: audioState.playbackType,
            volume: audioState.volume,
            isMuted: audioState.isMuted,
            repeatMode: audioState.repeatMode,
            setCurrentAudiobook: (
                value:
                    | Audiobook
                    | null
                    | ((previous: Audiobook | null) => Audiobook | null),
            ) => {
                audioState.currentAudiobook = applyValue(
                    value,
                    audioState.currentAudiobook,
                );
                audioStateSetterCalls.setCurrentAudiobook.push(
                    audioState.currentAudiobook,
                );
            },
            setCurrentTrack: (
                value:
                    | Track
                    | null
                    | ((previous: Track | null) => Track | null),
            ) => {
                audioState.currentTrack = applyValue(
                    value,
                    audioState.currentTrack,
                );
                audioStateSetterCalls.setCurrentTrack.push(
                    audioState.currentTrack,
                );
            },
            setCurrentPodcast: (
                value:
                    | Podcast
                    | null
                    | ((previous: Podcast | null) => Podcast | null),
            ) => {
                audioState.currentPodcast = applyValue(
                    value,
                    audioState.currentPodcast,
                );
                audioStateSetterCalls.setCurrentPodcast.push(
                    audioState.currentPodcast,
                );
            },
            setPlaybackType: (
                value:
                    | PlaybackType
                    | ((previous: PlaybackType) => PlaybackType),
            ) => {
                audioState.playbackType = applyValue(
                    value,
                    audioState.playbackType,
                );
                audioStateSetterCalls.setPlaybackType.push(
                    audioState.playbackType,
                );
            },
            setQueue: (value: Track[] | ((previous: Track[]) => Track[])) => {
                audioState.queue = applyValue(value, audioState.queue);
                audioStateSetterCalls.setQueue.push(audioState.queue);
            },
            queue: audioState.queue,
            currentIndex: audioState.currentIndex,
            isShuffle: audioState.isShuffle,
            shuffleIndices: audioState.shuffleIndices,
            vibeMode: audioState.vibeMode,
            waveMode: audioState.waveMode,
        }),
    },
});

mock.module("@/lib/audio-playback-context", {
    namedExports: {
        usePlaybackStatus: () => ({
            isPlaying: playbackState.isPlaying,
            setCurrentTime: (value: number) => {
                playbackState.currentTime = value;
                playbackCalls.setCurrentTime.push(value);
            },
            setCurrentTimeFromEngine: (value: number) => {
                playbackState.currentTime = value;
                playbackCalls.setCurrentTimeFromEngine.push(value);
            },
            setDuration: (value: number) => {
                playbackState.duration = value;
                playbackCalls.setDuration.push(value);
            },
            setIsPlaying: (value: boolean) => {
                playbackState.isPlaying = value;
                playbackCalls.setIsPlaying.push(value);
            },
            isBuffering: playbackState.isBuffering,
            setIsBuffering: (value: boolean) => {
                playbackState.isBuffering = value;
                playbackCalls.setIsBuffering.push(value);
            },
            setTargetSeekPosition: (value: number | null) => {
                playbackCalls.setTargetSeekPosition.push(value);
            },
            canSeek: playbackState.canSeek,
            setCanSeek: (value: boolean) => {
                playbackState.canSeek = value;
                playbackCalls.setCanSeek.push(value);
            },
            setDownloadProgress: (value: number | null) => {
                playbackCalls.setDownloadProgress.push(value);
            },
            setStreamProfile: (value: unknown) => {
                playbackCalls.setStreamProfile.push(value);
            },
        }),
        usePlaybackProgress: () => ({
            currentTime: playbackState.currentTime,
        }),
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => {
            const queueLengthAtRender = audioState.queue.length;
            return {
                pause: () => {
                    controlCalls.pause += 1;
                },
                next: () => {
                    controlCalls.next += 1;
                },
                advanceQueue: () => {
                    if (
                        !advanceQueueRequiresCapturedNext ||
                        queueLengthAtRender > 1
                    ) {
                        controlCalls.next += 1;
                    }
                },
                nextPodcastEpisode: () => {
                    controlCalls.nextPodcastEpisode += 1;
                },
                startVibeMode: async (options?: VibeModeStartOptions) => {
                    controlCalls.startVibeMode += 1;
                    return startVibeModeImpl(options);
                },
            };
        },
    },
});

mock.module("@/lib/audio-load-preemption", {
    namedExports: {
        shouldAllowInitialPersistedTrackResume: (input: {
            isInitialTrackLoad: boolean;
            listenTogetherActiveOrPending: boolean;
        }) => input.isInitialTrackLoad && !input.listenTogetherActiveOrPending,
        shouldPreemptInFlightAudioLoad: (input: {
            currentMediaId: string | null;
            previousMediaId: string | null;
            isLoading: boolean;
        }) => {
            preemptChecks.push(input);
            return Boolean(
                input.isLoading &&
                input.currentMediaId &&
                input.previousMediaId &&
                input.currentMediaId !== input.previousMediaId,
            );
        },
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getStreamUrl: (trackId: string) => {
                apiCalls.getStreamUrl.push(trackId);
                return `https://stream.test/direct/${trackId}`;
            },
            getTidalStreamUrl: (trackId: number) =>
                `https://stream.test/tidal/${trackId}`,
            getYtMusicStreamUrl: (videoId: string) =>
                `https://stream.test/yt/${videoId}`,
            recoverUnavailableYtMusicTrack: async (
                input: Record<string, unknown>,
            ) => {
                apiCalls.recoverUnavailableYtMusicTrack.push(input);
                return recoverUnavailableYtMusicTrackImpl(input);
            },
            getAudiobookStreamUrl: (bookId: string) =>
                `https://stream.test/audiobook/${bookId}`,
            getPodcastEpisodeStreamUrl: (
                podcastId: string,
                episodeId: string,
            ) => `https://stream.test/podcast/${podcastId}/${episodeId}`,
            getPodcastEpisodeCacheStatus: async (
                podcastId: string,
                episodeId: string,
            ) => {
                apiCalls.getPodcastEpisodeCacheStatus.push({
                    podcastId,
                    episodeId,
                });
                return {
                    cached: podcastCacheStatus.cached,
                    downloading: podcastCacheStatus.downloading,
                    downloadProgress: podcastCacheStatus.downloadProgress,
                };
            },
            updateAudiobookProgress: async () => undefined,
            updatePodcastProgress: async (
                podcastId: string,
                episodeId: string,
                positionSec: number,
                durationSec: number,
                isFinished: boolean,
            ) => {
                apiCalls.updatePodcastProgress.push({
                    podcastId,
                    episodeId,
                    positionSec,
                    durationSec,
                    isFinished,
                });
            },
            reportPlaybackClientMetric: async (
                payload: Record<string, unknown>,
            ) => {
                apiCalls.reportPlaybackClientMetric.push(payload);
            },
            logPlay: async (
                trackRef: Record<string, unknown>,
                context: Record<string, unknown>,
            ) => {
                apiCalls.logPlay.push({ trackRef, context });
                return { id: `play-${apiCalls.logPlay.length}` };
            },
            updatePlayEngagement: async (
                playId: string,
                input: Record<string, unknown>,
            ) => {
                apiCalls.updatePlayEngagement.push({ playId, input });
                return { success: true as const };
            },
            getYtMusicStatus: async () => ({
                enabled: false,
                available: false,
                authenticated: false,
            }),
        },
    },
});

mock.module("@/lib/audio-engine/engineMode", {
    namedExports: {
        resolveStreamingEngineMode: () => runtimeEngineMode,
    },
});

mock.module("@/lib/audio-engine/recoveryPolicy", {
    namedExports: {
        resolveLocalAuthoritativeRecovery: (
            local: { positionSec: number; shouldPlay: boolean },
            server?: { resumeAtSec?: number },
        ) => ({
            resumeAtSec: Math.max(
                0,
                local.positionSec > 0
                    ? local.positionSec
                    : Number.isFinite(server?.resumeAtSec)
                      ? (server?.resumeAtSec ?? 0)
                      : 0,
            ),
            shouldPlay: local.shouldPlay,
            authority: "local",
        }),
    },
});

mock.module("@/lib/audio-engine/playbackRecoveryPolicy", {
    namedExports: {
        ...realPlaybackRecoveryPolicy,
        isSeekWithinTolerance: (
            actual: number,
            target: number,
            toleranceSec?: number,
        ) =>
            seekToleranceOverride ??
            realPlaybackRecoveryPolicy.isSeekWithinTolerance(
                actual,
                target,
                toleranceSec,
            ),
    },
});

mock.module("@/lib/audio-seek-emitter", {
    namedExports: {
        audioSeekEmitter: {
            subscribe: (handler: (time: number) => void | Promise<void>) => {
                seekSubscribers.add(handler);
                return () => {
                    seekSubscribers.delete(handler);
                };
            },
        },
    },
});

mock.module("@/lib/query-events", {
    namedExports: {
        dispatchQueryEvent: () => undefined,
    },
});

mock.module("@/lib/listen-together-session", {
    namedExports: {
        enqueueLatestListenTogetherHostTrackOperation: async (operation: {
            action: string;
        }) => {
            listenTogetherHostTrackOperations.push(operation.action);
        },
        getListenTogetherSessionSnapshot: () => listenTogetherSnapshot,
        isListenTogetherActiveOrPending: () =>
            Boolean(listenTogetherSnapshot?.groupId),
        resolveListenTogetherFollowerGroupId: (
            snapshot: { groupId?: string; isHost?: boolean } | null,
        ) =>
            snapshot?.groupId && snapshot.isHost !== true
                ? snapshot.groupId
                : null,
        requestListenTogetherGroupResync: async (groupId?: string) => {
            if (typeof groupId === "string" && groupId.length > 0) {
                listenTogetherResyncCalls.push(groupId);
            }
        },
    },
});

mock.module("@/lib/storage-migration", {
    namedExports: {
        createMigratingStorageKey: (key: string) => key,
        PODCAST_DEBUG_STORAGE_KEY: "podcast_debug",
        readMigratingStorageItem: (key: string) =>
            migratingStorageItems.get(key) ?? null,
    },
});

const playbackMachine = { state: "IDLE" as string };
const heartbeatInstances: MockHeartbeatMonitor[] = [];

const transitionPlaybackMachine = (next: string): boolean => {
    playbackMachine.state = next;
    if (mirrorMachineIntentToPlaybackState && next === "READY") {
        playbackState.isPlaying = false;
        playbackCalls.setIsPlaying.push(false);
    }
    if (mirrorMachineIntentToPlaybackState && next === "PLAYING") {
        playbackState.isPlaying = true;
        playbackCalls.setIsPlaying.push(true);
    }
    return true;
};

class MockHeartbeatMonitor {
    public monitoring = false;
    public stalled = false;
    private options: Record<string, unknown>;
    private readonly callbacks: Record<string, () => void>;
    private bufferTimeout: NodeJS.Timeout | null = null;

    constructor(
        callbacks: Record<string, () => void>,
        options: Record<string, unknown> = {},
    ) {
        this.callbacks = callbacks;
        this.options = options;
        heartbeatInstances.push(this);
    }

    start(): void {
        this.monitoring = true;
    }

    stop(): void {
        this.monitoring = false;
    }

    startBufferTimeout(): void {
        this.clearBufferTimeout();
        const timeoutMs =
            typeof this.options.bufferTimeout === "number"
                ? this.options.bufferTimeout
                : 1000;
        this.bufferTimeout = setTimeout(() => {
            this.callbacks.onBufferTimeout?.();
        }, timeoutMs);
    }

    clearBufferTimeout(): void {
        if (this.bufferTimeout) {
            clearTimeout(this.bufferTimeout);
            this.bufferTimeout = null;
        }
    }

    updateConfig(next: Record<string, unknown>): void {
        this.options = { ...this.options, ...next };
    }

    notifyProgress(_time: number): void {}

    triggerStall(): void {
        this.callbacks.onStall?.();
    }

    triggerUnexpectedStop(): void {
        this.callbacks.onUnexpectedStop?.();
    }

    triggerBufferTimeout(): void {
        this.callbacks.onBufferTimeout?.();
    }

    destroy(): void {
        this.clearBufferTimeout();
        this.monitoring = false;
    }
}

mock.module("@/lib/audio", {
    namedExports: {
        playbackStateMachine: {
            transition: transitionPlaybackMachine,
            forceTransition: transitionPlaybackMachine,
            getState: () => playbackMachine.state,
            get isPlaying() {
                return playbackMachine.state === "PLAYING";
            },
            get isBuffering() {
                return playbackMachine.state === "BUFFERING";
            },
        },
        HeartbeatMonitor: MockHeartbeatMonitor,
    },
});

mock.module("@tanstack/react-query", {
    namedExports: {
        useQueryClient: () => ({
            prefetchQuery: async () => undefined,
        }),
    },
});

mock.module("@/hooks/useLyrics", {
    namedExports: {
        fetchLyrics: async () => null,
        lyricsQueryKeys: {
            lyrics: (trackId: string) => ["lyrics", trackId],
        },
    },
});

mock.module("@/lib/lyrics-cache-policy", {
    namedExports: {
        LYRICS_QUERY_STALE_TIME: 60_000,
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            error: (message: string) => {
                toastErrors.push(message);
            },
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: (() => {
            const logger = {
                info: (...args: unknown[]) => {
                    loggerCalls.info.push(args);
                },
                warn: (...args: unknown[]) => {
                    loggerCalls.warn.push(args);
                },
                error: (...args: unknown[]) => {
                    loggerCalls.error.push(args);
                },
                child: () => logger,
            };
            return logger;
        })(),
    },
});

mock.module("@soundspan/media-metadata-contract", {
    namedExports: {
        normalizeCanonicalMediaProviderIdentity: (input: {
            streamSource?: "local" | "tidal" | "youtube";
            tidalTrackId?: number;
            youtubeVideoId?: string;
        }) => {
            if (input.streamSource === "tidal" || input.tidalTrackId) {
                return { source: "tidal" };
            }
            if (input.streamSource === "youtube" || input.youtubeVideoId) {
                return { source: "youtube" };
            }
            return { source: "local" };
        },
        toAudioEngineSourceType: (source: "local" | "tidal" | "youtube") =>
            source === "youtube" ? "ytmusic" : source,
    },
});

let orchestratorComponent: (() => null) | null = null;

before(async () => {
    const orchestratorModule =
        await import("../../components/player/AudioPlaybackOrchestrator");
    orchestratorComponent =
        orchestratorModule.AudioPlaybackOrchestrator as unknown as () => null;
});

beforeEach(() => {
    resetHarnessState();
    playbackMachine.state = "IDLE";
    clearPlaybackHeartbeat();
});

afterEach(() => {
    hookRuntime.unmount();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
    try {
        mock.timers.reset();
    } catch {
        // No timer mocks were active in this test.
    }
});

const renderOrchestrator = (): void => {
    assert.ok(orchestratorComponent, "orchestrator should be imported");
    hookRuntime.render(orchestratorComponent as () => null);
};

const rerenderOrchestrator = (): void => {
    assert.ok(orchestratorComponent, "orchestrator should be imported");
    hookRuntime.render(orchestratorComponent as () => null);
};

const flushAsync = async (ticks = 6): Promise<void> => {
    for (let index = 0; index < ticks; index += 1) {
        await Promise.resolve();
    }
};

const enableWindowMetrics = (
    runtimeConfig: Record<string, unknown> = {},
): void => {
    (globalThis as unknown as { window?: Record<string, unknown> }).window = {
        __SOUNDSPAN_RUNTIME_CONFIG__: runtimeConfig,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
};

const getServerSignalEvents = (
    eventName: string,
): Array<Record<string, unknown>> => {
    return apiCalls.reportPlaybackClientMetric.filter(
        (payload) => payload.event === eventName,
    );
};

const emitFatalLoadError = async (): Promise<void> => {
    engine.emit("loaderror", {
        error: new Error("fatal decode failure"),
        code: "MEDIA_ERR_DECODE",
        recoverable: false,
    });
    await flushAsync(10);
};

const failPlayingTrack = async (): Promise<void> => {
    engine.emit("load", { durationSec: 210 });
    engine.playing = true;
    engine.emit("play");
    await emitFatalLoadError();
    mock.timers.tick(1_201);
    await flushAsync();
};

const selectTrack = (tracks: Track[], index: number): void => {
    audioState.currentTrack = tracks[index];
    audioState.currentIndex = index;
    rerenderOrchestrator();
};

const applyListenTogetherResume = async (
    tracks: Track[],
    index: number,
): Promise<void> => {
    markRemoteTrackChange(
        audioState.currentTrack?.id ?? null,
        tracks[index]?.id ?? null,
    );
    selectTrack(tracks, index);
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    await flushAsync();
    playbackState.isPlaying = true;
    rerenderOrchestrator();
    await flushAsync();
};

const applyManualListenTogetherSelection = async (
    tracks: Track[],
    index: number,
): Promise<void> => {
    writePlaybackAdvanceOrigin("manual", audioState.currentTrack?.id ?? null);
    await applyListenTogetherResume(tracks, index);
};

const extractedHookNames = [
    "usePlaybackOrchestratorRefs",
    "useApplyCurrentOutputState",
    "usePlaybackRecoveryHelpers",
    "useTrackRecovery",
    "useYtMusicAuth",
    "useAutoMatchVibe",
    "usePlaybackStateSync",
    "useQueueRecoveryEffects",
    "usePlaybackWatchdogs",
    "usePlaybackMetadataSync",
    "useProgressSaveCallbacks",
    "useAudioEngineBindings",
    "useForegroundRecovery",
    "useNextTrackPreload",
    "usePlaybackControlSync",
    "usePodcastSeeking",
    "useProgressPersistence",
    "usePlaybackUnmountCleanup",
] as const;

for (const hookName of extractedHookNames) {
    test(`mounts and cleans the extracted ${hookName} hook`, () => {
        renderOrchestrator();
        assert.doesNotThrow(() => hookRuntime.unmount());
    });
}

test("live engine load, play, and progress refresh service-worker playback liveness", () => {
    audioState.currentTrack = makeTrack("heartbeat-track");
    audioState.playbackType = "track";
    renderOrchestrator();

    assert.equal(hasFreshPlaybackHeartbeat(), true);

    engine.playing = true;
    engine.emit("play");
    assert.equal(hasFreshPlaybackHeartbeat(), true);

    clearPlaybackHeartbeat();
    engine.currentTime = 1;
    engine.emit("timeupdate", { timeSec: 1 });
    assert.equal(hasFreshPlaybackHeartbeat(), true);
});

test("recoverable autoplay rejection preserves the track without scheduling a skip", async () => {
    mock.timers.enable();
    playbackState.isPlaying = true;
    const currentTrack = makeTrack("autoplay-blocked");
    audioState.currentTrack = currentTrack;
    audioState.queue = [currentTrack, makeTrack("autoplay-next")];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.playing = true;
    engine.emit("play");
    await flushAsync();

    engine.playing = false;
    engine.emit("playerror", {
        error: new DOMException("Play requires a gesture", "NotAllowedError"),
        code: "NotAllowedError",
        recoverable: true,
    });
    await flushAsync(10);

    assert.equal(audioState.currentTrack?.id, "autoplay-blocked");
    assert.equal(playbackState.isPlaying, false);
    assert.equal(playbackState.isBuffering, true);
    assert.notEqual(playbackMachine.state, "ERROR");

    mock.timers.tick(1_201);
    await flushAsync();
    assert.equal(controlCalls.next, 0);

    engine.playing = true;
    engine.emit("play");
    await flushAsync();
    assert.equal(playbackMachine.state, "PLAYING");
    assert.equal(playbackState.isPlaying, true);
});

test("unavailable YouTube Music playback swaps in the validated alternate without skipping", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    const failedTrack = makeTrack("yt:z0NfI2NeDHI", {
        title: "Radio (Official Video)",
        streamSource: "youtube",
        youtubeVideoId: "z0NfI2NeDHI",
        artist: { name: "Rammstein" },
        album: { title: "Rammstein" },
        playlistItemId: "playlist-item-1",
        trackYtMusicId: "yt-row-original",
        provider: {
            source: "youtube",
            providerTrackId: "z0NfI2NeDHI",
            youtubeVideoId: "z0NfI2NeDHI",
        },
    });
    const repeatedOccurrence = {
        ...failedTrack,
        playlistItemId: "playlist-item-2",
    };
    audioState.currentTrack = failedTrack;
    audioState.queue = [
        failedTrack,
        repeatedOccurrence,
        makeTrack("next-after-unavailable"),
    ];
    recoverUnavailableYtMusicTrackImpl = async () => ({
        status: "replaced",
        originalVideoId: "z0NfI2NeDHI",
        replacement: {
            videoId: "alternate02",
            title: "Radio",
            duration: 274,
            trackYtMusicId: "yt-row-alternate",
        },
        persisted: true,
    });

    renderOrchestrator();
    await flushAsync();
    await emitFatalLoadError();

    assert.equal(apiCalls.recoverUnavailableYtMusicTrack.length, 1);
    assert.deepEqual(
        apiCalls.recoverUnavailableYtMusicTrack[0]?.excludedVideoIds,
        ["z0NfI2NeDHI"],
    );
    assert.equal(audioState.currentTrack?.youtubeVideoId, "alternate02");
    assert.equal(audioState.currentTrack?.trackYtMusicId, "yt-row-alternate");
    assert.equal(audioState.queue[0]?.youtubeVideoId, "alternate02");
    assert.equal(audioState.queue[1]?.youtubeVideoId, "z0NfI2NeDHI");
    assert.equal(audioState.queue[1]?.trackYtMusicId, "yt-row-original");
    assert.equal(controlCalls.next, 0);

    rerenderOrchestrator();
    await flushAsync();
    assert.equal(
        engine.loadCalls.at(-1)?.args[0],
        "https://stream.test/yt/alternate02",
    );

    t.mock.timers.tick(1_201);
    await flushAsync();
    assert.equal(controlCalls.next, 0);
});

test("unavailable YouTube Music playback keeps the existing skip when no alternate exists", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    const failedTrack = makeTrack("yt:z0NfI2NeDHI", {
        title: "Radio (Official Video)",
        streamSource: "youtube",
        youtubeVideoId: "z0NfI2NeDHI",
        artist: { name: "Rammstein" },
        album: { title: "Rammstein" },
    });
    audioState.currentTrack = failedTrack;
    audioState.queue = [failedTrack, makeTrack("next-after-no-candidate")];
    recoverUnavailableYtMusicTrackImpl = async () => ({
        status: "no_candidate",
        originalVideoId: "z0NfI2NeDHI",
        replacement: null,
        persisted: false,
    });

    renderOrchestrator();
    await flushAsync();
    await emitFatalLoadError();
    assert.equal(controlCalls.next, 0);

    t.mock.timers.tick(1_201);
    await flushAsync();
    assert.equal(controlCalls.next, 1);
});

test("distinct provider tracks confirmed unavailable continue past the system breaker threshold", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    const unavailableTracks = [
        makeTrack("yt:unavail0001", {
            streamSource: "youtube",
            youtubeVideoId: "unavail0001",
            artist: { name: "Unavailable Artist 1" },
        }),
        makeTrack("yt:unavail0002", {
            streamSource: "youtube",
            youtubeVideoId: "unavail0002",
            artist: { name: "Unavailable Artist 2" },
        }),
        makeTrack("yt:unavail0003", {
            streamSource: "youtube",
            youtubeVideoId: "unavail0003",
            artist: { name: "Unavailable Artist 3" },
        }),
    ];
    audioState.currentTrack = unavailableTracks[0];
    audioState.queue = [
        ...unavailableTracks,
        makeTrack("playable-after-unavailable"),
    ];
    recoverUnavailableYtMusicTrackImpl = async (input) => ({
        status: "no_candidate",
        originalVideoId: input.originalVideoId,
        replacement: null,
        persisted: false,
    });

    renderOrchestrator();
    await flushAsync();

    for (let index = 0; index < unavailableTracks.length; index += 1) {
        await emitFatalLoadError();
        t.mock.timers.tick(1_201);
        await flushAsync();
        assert.equal(controlCalls.next, index + 1);

        if (index < unavailableTracks.length - 1) {
            selectTrack(unavailableTracks, index + 1);
            await flushAsync();
        }
    }

    assert.equal(isPlaybackAutoRestartSuppressed(), false);
    assert.doesNotMatch(toastErrors.join(" "), /multiple tracks failed/i);
});

test("a repeated confirmed-unavailable provider item stops a queue recovery cycle", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    const firstUnavailable = makeTrack("yt:repeat00001", {
        streamSource: "youtube",
        youtubeVideoId: "repeat00001",
        artist: { name: "Unavailable Artist 1" },
    });
    const secondUnavailable = makeTrack("yt:repeat00002", {
        streamSource: "youtube",
        youtubeVideoId: "repeat00002",
        artist: { name: "Unavailable Artist 2" },
    });
    const tracks = [
        firstUnavailable,
        secondUnavailable,
        { ...firstUnavailable },
        makeTrack("must-not-loop-forever"),
    ];
    audioState.currentTrack = tracks[0];
    audioState.queue = tracks;
    recoverUnavailableYtMusicTrackImpl = async (input) => ({
        status: "no_candidate",
        originalVideoId: input.originalVideoId,
        replacement: null,
        persisted: false,
    });

    renderOrchestrator();
    await flushAsync();

    for (const index of [0, 1]) {
        await emitFatalLoadError();
        t.mock.timers.tick(1_201);
        await flushAsync();
        assert.equal(controlCalls.next, index + 1);
        selectTrack(tracks, index + 1);
        await flushAsync();
    }

    await emitFatalLoadError();
    t.mock.timers.tick(1_201);
    await flushAsync();

    assert.equal(controlCalls.next, 2);
    assert.equal(isPlaybackAutoRestartSuppressed(), true);
});

test("preparing a verified legacy copy keeps its media identity without shadowing the active network source", async () => {
    const track = makeTrack("downloaded-track", {
        streamSource: "youtube",
        youtubeVideoId: "downloaded-video",
    });
    const record = {
        key: "downloaded-key",
        ownerId: "user-1",
        trackIdentity: "youtube:downloaded-video",
        quality: "auto",
        virtualUrl: "/__offline/audio/downloaded-key",
        sourceUrl: "/api/ytmusic/stream-public/downloaded-video",
        track,
        status: "ready",
        transferMode: "foreground",
        backgroundFetchId: null,
        bytesReceived: 6,
        totalBytes: 6,
        contentType: "audio/mp4",
        persistenceGranted: true,
        attempt: 1,
        createdAt: 1,
        updatedAt: 1,
        errorCode: null,
        errorMessage: null,
    } as DeviceOfflineDownloadRecord;
    setDeviceOfflineRuntimeState("user-1", [record]);
    audioState.currentTrack = track;
    audioState.queue = [track];

    renderOrchestrator();
    await flushAsync();
    assert.equal(
        engine.loadCalls.at(-1)?.args[0],
        "https://stream.test/yt/downloaded-video",
    );

    assert.equal(
        prepareDeviceOfflinePlaybackSource(
            "user-1",
            record,
            "blob:https://soundspan.test/downloaded-key",
            () => undefined,
        ),
        true,
    );
    audioState.currentTrack = { ...track };
    audioState.queue = [audioState.currentTrack];
    rerenderOrchestrator();
    await flushAsync();

    assert.equal(
        engine.loadCalls.at(-1)?.args[0],
        "https://stream.test/yt/downloaded-video",
    );
    assert.equal(engine.loadCalls.length, 1);
});

test("rapid manual YouTube selections start only the latest remote stream", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const tracks = Array.from({ length: 6 }, (_, index) =>
        makeTrack(`rapid-youtube-${index + 1}`, {
            streamSource: "youtube",
            youtubeVideoId: `rapidvideo0${index + 1}`,
        }),
    );
    audioState.currentTrack = tracks[0];
    audioState.queue = tracks;
    playbackState.isPlaying = true;

    renderOrchestrator();
    await flushAsync();
    assert.equal(engine.loadCalls.length, 1);
    assert.equal(
        engine.preloadCalls.length,
        0,
        "network YouTube preloads must not bypass the latest manual selection gate",
    );

    for (const [index, intervalMs] of [250, 500, 750, 1000].entries()) {
        writePlaybackReplacementIntent(tracks[index].id);
        selectTrack(tracks, index + 1);
        await flushAsync();
        t.mock.timers.tick(intervalMs);
        await flushAsync();
        assert.equal(engine.loadCalls.length, 1);
        assert.equal(engine.preloadCalls.length, 0);
    }

    writePlaybackReplacementIntent(tracks[4].id);
    selectTrack(tracks, 5);
    await flushAsync();

    assert.equal(engine.loadCalls.length, 1);
    assert.equal(engine.preloadCalls.length, 0);
    t.mock.timers.tick(1249);
    await flushAsync();
    assert.equal(engine.loadCalls.length, 1);
    assert.equal(engine.preloadCalls.length, 0);
    t.mock.timers.tick(1);
    await flushAsync();

    assert.equal(engine.loadCalls.length, 2);
    assert.equal(
        engine.loadCalls.at(-1)?.args[0],
        "https://stream.test/yt/rapidvideo06",
    );
});

test("a late device-file lease cannot load a retired track and every acquired URL is released", async (t) => {
    const firstTrack = makeTrack("yt:first-file", {
        streamSource: "youtube",
        youtubeVideoId: "first-file",
    });
    const secondTrack = makeTrack("yt:second-file", {
        streamSource: "youtube",
        youtubeVideoId: "second-file",
    });
    const firstRef = "fsa1:user:first" as DeviceAudioVaultRef;
    const secondRef = "fsa1:user:second" as DeviceAudioVaultRef;
    const firstAccess = deferred<DeviceAudioPlayResult>();
    let firstReleases = 0;
    let secondReleases = 0;
    const session = {
        ownerId: "user-1",
        authGeneration: 0,
        storage: { kind: "desktop-directory", label: "Test music" },
        retain: async () => {
            throw new Error("retain is not used by playback");
        },
        access: (input: { ref: DeviceAudioVaultRef }) => {
            if (input.ref === firstRef) return firstAccess.promise;
            return Promise.resolve({
                kind: "play" as const,
                url: "blob:https://soundspan.test/second",
                release: () => secondReleases++,
            });
        },
    } as unknown as DeviceAudioVaultSession;
    const restoreVault = installDeviceAudioVaultFactory(() =>
        fakeDeviceAudioVault(async ({ authGeneration }) => {
            return { ...session, authGeneration };
        }),
    );
    t.after(restoreVault);
    setDeviceOfflineRuntimeState("user-1", [
        managedReadyRecord("user-1", "first-key", firstTrack, firstRef),
        managedReadyRecord("user-1", "second-key", secondTrack, secondRef),
    ]);
    audioState.currentTrack = firstTrack;
    audioState.queue = [firstTrack, secondTrack];

    renderOrchestrator();
    await flushAsync();
    assert.equal(engine.loadCalls.length, 0);

    audioState.currentTrack = secondTrack;
    audioState.currentIndex = 1;
    rerenderOrchestrator();
    await flushAsync();
    assert.equal(engine.loadCalls.length, 1);
    assert.equal(
        engine.loadCalls[0]?.args[0],
        "blob:https://soundspan.test/second",
    );

    firstAccess.resolve({
        kind: "play",
        url: "blob:https://soundspan.test/first-too-late",
        release: () => firstReleases++,
    });
    await flushAsync();
    assert.equal(engine.loadCalls.length, 1);
    assert.equal(firstReleases, 1);

    hookRuntime.unmount();
    assert.equal(secondReleases, 1);
});

test("a terminal offline error releases the active device-file playback lease", async (t) => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "navigator",
    );
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { onLine: false },
    });
    t.after(() => {
        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }
    });

    const track = makeTrack("yt:offline-file", {
        streamSource: "youtube",
        youtubeVideoId: "offline-file",
    });
    const ref = "fsa1:user:offline" as DeviceAudioVaultRef;
    let releases = 0;
    const restoreVault = installDeviceAudioVaultFactory(() =>
        fakeDeviceAudioVault(
            async ({ ownerId, authGeneration }) =>
                ({
                    ownerId,
                    authGeneration,
                    storage: {
                        kind: "desktop-directory",
                        label: "Test music",
                    },
                    retain: async () => {
                        throw new Error("retain is not used by playback");
                    },
                    access: async () => ({
                        kind: "play" as const,
                        url: "blob:https://soundspan.test/offline",
                        release: () => {
                            releases += 1;
                        },
                    }),
                }) as unknown as DeviceAudioVaultSession,
        ),
    );
    t.after(restoreVault);
    setDeviceOfflineRuntimeState("user-1", [
        managedReadyRecord("user-1", "offline-key", track, ref),
    ]);
    audioState.currentTrack = track;
    audioState.queue = [track];

    renderOrchestrator();
    await flushAsync();
    assert.equal(
        engine.loadCalls.at(-1)?.args[0],
        "blob:https://soundspan.test/offline",
    );

    engine.emit("loaderror", {
        error: new TypeError("network disconnected"),
        code: "MEDIA_ERR_NETWORK",
        recoverable: false,
    });
    await flushAsync(10);
    assert.equal(releases, 1);
});

test("next-track preload acquires and releases its own managed device-file lease", async (t) => {
    const currentTrack = makeTrack("current-network");
    const nextTrack = makeTrack("yt:preloaded-file", {
        streamSource: "youtube",
        youtubeVideoId: "preloaded-file",
    });
    const followingNetworkTrack = makeTrack("yt:following-network", {
        streamSource: "youtube",
        youtubeVideoId: "following-network",
    });
    const nextRef = "fsa1:user:preload" as DeviceAudioVaultRef;
    let releases = 0;
    const session = {
        ownerId: "user-1",
        authGeneration: 0,
        storage: { kind: "desktop-directory", label: "Test music" },
        retain: async () => {
            throw new Error("retain is not used by playback");
        },
        access: async () => ({
            kind: "play" as const,
            url: "blob:https://soundspan.test/preload",
            release: () => releases++,
        }),
    } as unknown as DeviceAudioVaultSession;
    const restoreVault = installDeviceAudioVaultFactory(() =>
        fakeDeviceAudioVault(async ({ authGeneration }) => ({
            ...session,
            authGeneration,
        })),
    );
    t.after(restoreVault);
    setDeviceOfflineRuntimeState("user-1", [
        managedReadyRecord("user-1", "preload-key", nextTrack, nextRef),
    ]);
    audioState.currentTrack = currentTrack;
    audioState.queue = [currentTrack, nextTrack, followingNetworkTrack];
    playbackState.isPlaying = true;

    renderOrchestrator();
    await flushAsync();

    assert.deepEqual(engine.preloadCalls, [
        { url: "blob:https://soundspan.test/preload", format: "mp4" },
    ]);
    assert.equal(releases, 0);

    audioState.currentTrack = nextTrack;
    audioState.currentIndex = 1;
    rerenderOrchestrator();
    await flushAsync();

    assert.equal(engine.preloadCalls.length, 1);
    assert.equal(releases, 1);
});

test("stale downloaded metadata cannot reopen a network YouTube preload", async () => {
    const currentTrack = makeTrack("current-before-stale-copy");
    const staleTrack = makeTrack("yt:stale-copy", {
        streamSource: "youtube",
        youtubeVideoId: "stale-copy",
    });
    const staleRecord = managedReadyRecord(
        "user-1",
        "stale-copy-key",
        staleTrack,
        "fsa1:user:stale-copy" as DeviceAudioVaultRef,
    );
    delete staleRecord.mediaRef;
    setDeviceOfflineRuntimeState("user-1", [staleRecord]);
    audioState.currentTrack = currentTrack;
    audioState.queue = [currentTrack, staleTrack];
    playbackState.isPlaying = true;

    renderOrchestrator();
    await flushAsync();

    assert.equal(engine.preloadCalls.length, 0);
});

test("a recoverable device-file error cannot reopen a network YouTube preload", async (t) => {
    const currentTrack = makeTrack("current-before-unavailable-copy");
    const unavailableTrack = makeTrack("yt:unavailable-copy", {
        streamSource: "youtube",
        youtubeVideoId: "unavailable-copy",
    });
    const unavailableRef = "fsa1:user:unavailable-copy" as DeviceAudioVaultRef;
    const session = {
        ownerId: "user-1",
        authGeneration: 0,
        storage: { kind: "desktop-directory", label: "Test music" },
        retain: async () => {
            throw new Error("retain is not used by playback");
        },
        access: async () => {
            throw new DeviceAudioVaultError(
                "permission_required",
                "Directory permission is no longer available",
                "user-action",
            );
        },
    } as unknown as DeviceAudioVaultSession;
    const restoreVault = installDeviceAudioVaultFactory(() =>
        fakeDeviceAudioVault(async ({ authGeneration }) => ({
            ...session,
            authGeneration,
        })),
    );
    t.after(restoreVault);
    setDeviceOfflineRuntimeState("user-1", [
        managedReadyRecord(
            "user-1",
            "unavailable-copy-key",
            unavailableTrack,
            unavailableRef,
        ),
    ]);
    audioState.currentTrack = currentTrack;
    audioState.queue = [currentTrack, unavailableTrack];
    playbackState.isPlaying = true;

    renderOrchestrator();
    await flushAsync();

    assert.equal(engine.preloadCalls.length, 0);
});

test("a late resolved preload cannot replace a newer managed device copy", async (t) => {
    const currentTrack = makeTrack("current-before-preload-race");
    const firstTrack = makeTrack("yt:first-preload-race", {
        streamSource: "youtube",
        youtubeVideoId: "first-preload-race",
    });
    const secondTrack = makeTrack("yt:second-preload-race", {
        streamSource: "youtube",
        youtubeVideoId: "second-preload-race",
    });
    const firstRef = "fsa1:user:first-preload-race" as DeviceAudioVaultRef;
    const secondRef = "fsa1:user:second-preload-race" as DeviceAudioVaultRef;
    const firstAccess = deferred<DeviceAudioPlayResult>();
    const session = {
        ownerId: "user-1",
        authGeneration: 0,
        storage: { kind: "desktop-directory", label: "Test music" },
        retain: async () => {
            throw new Error("retain is not used by playback");
        },
        access: (input: { ref: DeviceAudioVaultRef }) =>
            input.ref === firstRef
                ? firstAccess.promise
                : Promise.resolve({
                      kind: "play" as const,
                      url: "blob:https://soundspan.test/second-preload-race",
                      release: () => undefined,
                  }),
    } as unknown as DeviceAudioVaultSession;
    const restoreVault = installDeviceAudioVaultFactory(() =>
        fakeDeviceAudioVault(async ({ authGeneration }) => ({
            ...session,
            authGeneration,
        })),
    );
    t.after(restoreVault);
    setDeviceOfflineRuntimeState("user-1", [
        managedReadyRecord(
            "user-1",
            "first-preload-race-key",
            firstTrack,
            firstRef,
        ),
        managedReadyRecord(
            "user-1",
            "second-preload-race-key",
            secondTrack,
            secondRef,
        ),
    ]);
    audioState.currentTrack = currentTrack;
    audioState.queue = [currentTrack, firstTrack, secondTrack];
    playbackState.isPlaying = true;

    renderOrchestrator();
    await flushAsync();
    firstAccess.resolve({
        kind: "play",
        url: "blob:https://soundspan.test/first-preload-race",
        release: () => undefined,
    });
    await Promise.resolve();
    await Promise.resolve();

    audioState.currentTrack = firstTrack;
    audioState.currentIndex = 1;
    rerenderOrchestrator();
    await flushAsync();

    assert.deepEqual(engine.preloadCalls, [
        {
            url: "blob:https://soundspan.test/second-preload-race",
            format: "mp4",
        },
    ]);
});

test("offline playback failure pauses once without cascading through the queue", async (t) => {
    mock.timers.enable();
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "navigator",
    );
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { onLine: false },
    });
    t.after(() => {
        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }
    });

    const tracks = [
        makeTrack("offline-1", {
            streamSource: "youtube",
            youtubeVideoId: "offline-video-1",
        }),
        makeTrack("offline-2", {
            streamSource: "youtube",
            youtubeVideoId: "offline-video-2",
        }),
    ];
    audioState.currentTrack = tracks[0];
    audioState.queue = tracks;
    playbackState.isPlaying = true;

    renderOrchestrator();
    await flushAsync();
    engine.emit("loaderror", {
        error: new TypeError("network disconnected"),
        code: "MEDIA_ERR_NETWORK",
        recoverable: false,
    });
    engine.emit("playerror", {
        error: new TypeError("network still disconnected"),
        code: "MEDIA_ERR_NETWORK",
        recoverable: false,
    });
    await flushAsync(10);
    mock.timers.tick(10_000);
    await flushAsync();

    assert.equal(controlCalls.next, 0);
    assert.equal(playbackState.isPlaying, false);
    assert.equal(playbackState.isBuffering, false);
    assert.ok(toastErrors.length <= 1);
    if (toastErrors[0]) {
        assert.match(toastErrors[0], /offline/i);
        assert.doesNotMatch(toastErrors[0], /trying the next track/i);
    }
    assert.doesNotMatch(toastErrors.join(" "), /multiple tracks failed/i);
});

test("temporary YouTube source rejection stops on the current track without cascading", async () => {
    enableWindowMetrics();
    playbackState.isPlaying = true;
    const failedTrack = makeTrack("provider-challenge-track", {
        title: "Temporarily blocked track",
        streamSource: "youtube",
        youtubeVideoId: "challenge01",
    });
    audioState.currentTrack = failedTrack;
    audioState.queue = [failedTrack, makeTrack("must-not-auto-skip")];

    renderOrchestrator();
    await flushAsync();
    engine.emit("loaderror", {
        error: new Error("provider_challenge"),
        code: "4",
        recoverable: false,
    });
    await flushAsync(10);

    assert.equal(controlCalls.next, 0);
    assert.equal(engine.reloadCalls, 0);
    assert.equal(engine.stopCalls, 1);
    assert.equal(playbackMachine.state, "ERROR");
    assert.equal(apiCalls.recoverUnavailableYtMusicTrack.length, 0);
    assert.equal(playbackState.isPlaying, false);
    assert.equal(playbackState.isBuffering, false);
    assert.equal(audioState.currentTrack?.id, failedTrack.id);
    assert.ok(toastErrors.length <= 1);
    if (toastErrors[0]) {
        assert.match(toastErrors[0], /временно недоступен/i);
    }
    assert.doesNotMatch(toastErrors.join(" "), /Пробуем следующий трек/i);
    assert.ok(
        getServerSignalEvents("player.playback_error").some(
            (event) =>
                (event.fields as Record<string, unknown> | undefined)?.stage ===
                "provider_startup_paused",
        ),
        JSON.stringify(apiCalls.reportPlaybackClientMetric),
    );
});

test("offline load timeout stops without retrying or advancing the queue", async (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "navigator",
    );
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { onLine: false },
    });
    t.after(() => {
        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }
    });

    const failedTrack = makeTrack("offline-timeout");
    audioState.currentTrack = failedTrack;
    audioState.queue = [failedTrack, makeTrack("must-not-autoskip")];
    playbackState.isPlaying = true;

    renderOrchestrator();
    await flushAsync();
    assert.equal(engine.loadCalls.length, 1);

    mock.timers.tick(20_000);
    await flushAsync();
    mock.timers.tick(350);
    await flushAsync();
    assert.equal(engine.loadCalls.length, 1);

    mock.timers.tick(25_000);
    await flushAsync();
    assert.equal(controlCalls.next, 0);
    assert.equal(playbackState.isPlaying, false);
    assert.equal(playbackState.isBuffering, false);
    assert.equal(playbackMachine.state, "ERROR");
    assert.ok(toastErrors.length <= 1);
});

test("foreground visibility does not bypass a tripped failure breaker", async () => {
    mock.timers.enable();
    const visibilityDocument = installVisibilityDocument();
    const tracks = [
        makeTrack("breaker-1"),
        makeTrack("breaker-2"),
        makeTrack("breaker-3"),
        makeTrack("breaker-4"),
    ];
    audioState.currentTrack = tracks[0];
    audioState.queue = tracks;

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });

    await emitFatalLoadError();
    mock.timers.tick(1_201);
    await flushAsync();
    assert.equal(controlCalls.next, 1);

    audioState.currentTrack = tracks[1];
    audioState.currentIndex = 1;
    rerenderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    await emitFatalLoadError();
    mock.timers.tick(1_201);
    await flushAsync();
    assert.equal(controlCalls.next, 2);

    audioState.currentTrack = tracks[2];
    audioState.currentIndex = 2;
    rerenderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    await emitFatalLoadError();
    mock.timers.tick(1_201);
    await flushAsync();
    assert.equal(controlCalls.next, 2);

    visibilityDocument.dispatchVisibility("hidden");
    visibilityDocument.dispatchVisibility("visible");

    await emitFatalLoadError();
    mock.timers.tick(1_201);
    await flushAsync();
    assert.equal(controlCalls.next, 2);
    assert.equal(isPlaybackAutoRestartSuppressed(), true);
});

test("three play events without playback progress trip the error breaker", async () => {
    mock.timers.enable();
    const tracks = [
        makeTrack("failed-play-1"),
        makeTrack("failed-play-2"),
        makeTrack("failed-play-3"),
        makeTrack("unreached-track"),
    ];
    audioState.currentTrack = tracks[0];
    audioState.queue = tracks;

    renderOrchestrator();
    await flushAsync();

    for (let index = 0; index < 3; index += 1) {
        await failPlayingTrack();

        if (index < 2) {
            selectTrack(tracks, index + 1);
            await flushAsync();
        }
    }

    assert.equal(controlCalls.next, 2);
});

test("a manual selection rejects a late failure from its superseded occurrence", async () => {
    mock.timers.enable();
    const tracks = [
        makeTrack("manual-stale-1"),
        makeTrack("manual-stale-2"),
        makeTrack("manual-fresh"),
        makeTrack("manual-next"),
    ];
    audioState.currentTrack = tracks[0];
    audioState.queue = tracks;

    renderOrchestrator();
    await flushAsync();

    await failPlayingTrack();
    selectTrack(tracks, 1);
    await flushAsync();
    await failPlayingTrack();
    assert.equal(controlCalls.next, 2);

    writePlaybackReplacementIntent(tracks[1].id);
    await emitFatalLoadError();
    assert.equal(
        loggerCalls.warn.some((args) =>
            String(args[0]).includes("circuit breaker tripped"),
        ),
        false,
    );
    assert.doesNotMatch(toastErrors.join(" "), /multiple tracks failed/i);

    selectTrack(tracks, 2);
    await flushAsync();
    await failPlayingTrack();
    assert.equal(controlCalls.next, 3);
    assert.equal(isPlaybackAutoRestartSuppressed(), false);
});

test("listen-together host error advances preserve consecutive failures until the breaker trips", async () => {
    mock.timers.enable();
    const tracks = [
        makeTrack("lt-host-failure-1"),
        makeTrack("lt-host-failure-2"),
        makeTrack("lt-host-failure-3"),
        makeTrack("lt-host-unreached"),
    ];
    listenTogetherSnapshot = { groupId: "lt-host-breaker", isHost: true };
    audioState.currentTrack = tracks[0];
    audioState.queue = tracks;

    renderOrchestrator();
    await flushAsync();

    for (let index = 0; index < 3; index += 1) {
        await failPlayingTrack();
        if (index < 2) {
            if (index === 0) mock.timers.tick(31_000);
            await applyListenTogetherResume(tracks, index + 1);
        }
    }

    assert.deepEqual(listenTogetherHostTrackOperations, ["next", "next"]);
    assert.ok(
        loggerCalls.warn.some((args) =>
            String(args[0]).includes("circuit breaker tripped"),
        ),
    );
});

test("listen-together follower resync preserves consecutive failures until the breaker trips", async () => {
    mock.timers.enable();
    const tracks = [
        makeTrack("lt-follower-failure-1"),
        makeTrack("lt-follower-failure-2"),
        makeTrack("lt-follower-failure-3"),
        makeTrack("lt-follower-unreached"),
    ];
    listenTogetherSnapshot = {
        groupId: "lt-follower-breaker",
        isHost: false,
    };
    audioState.currentTrack = tracks[0];
    audioState.queue = tracks;

    renderOrchestrator();
    await flushAsync();

    for (let index = 0; index < 3; index += 1) {
        await failPlayingTrack();
        if (index < 2) {
            await applyListenTogetherResume(tracks, index + 1);
        }
    }

    assert.deepEqual(listenTogetherResyncCalls, [
        "lt-follower-breaker",
        "lt-follower-breaker",
    ]);
    assert.ok(
        loggerCalls.warn.some((args) =>
            String(args[0]).includes("circuit breaker tripped"),
        ),
    );
    assert.equal(playbackState.isBuffering, false);
    assert.equal(playbackMachine.state, "READY");
    assert.equal(isPlaybackAutoRestartSuppressed(), true);
});

test("same-track follower recoveries confirm progress after every fatal error", async () => {
    mock.timers.enable();
    const track = makeTrack("lt-follower-same-track-recovery");
    listenTogetherSnapshot = {
        groupId: "lt-follower-same-track-recovery",
        isHost: false,
    };
    audioState.currentTrack = track;
    audioState.queue = [track, makeTrack("lt-follower-next")];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.playing = true;
    engine.emit("play");
    engine.emit("timeupdate", { timeSec: 0 });
    engine.emit("timeupdate", { timeSec: 0.5 });

    for (const baselineSeconds of [10, 20, 30]) {
        await emitFatalLoadError();
        mock.timers.tick(1_201);
        await flushAsync();
        engine.emit("load", { durationSec: 210 });
        engine.playing = true;
        engine.emit("timeupdate", { timeSec: baselineSeconds });
        engine.emit("timeupdate", { timeSec: baselineSeconds + 0.5 });
    }

    assert.deepEqual(listenTogetherResyncCalls, [
        "lt-follower-same-track-recovery",
        "lt-follower-same-track-recovery",
        "lt-follower-same-track-recovery",
    ]);
    assert.equal(
        loggerCalls.warn.some((args) =>
            String(args[0]).includes("circuit breaker tripped"),
        ),
        false,
    );
    assert.equal(isPlaybackAutoRestartSuppressed(), false);
});

test("fresh host media resets two follower failures before the next failure", async () => {
    mock.timers.enable();
    const tracks = [
        makeTrack("lt-follower-prior-1"),
        makeTrack("lt-follower-prior-2"),
        makeTrack("lt-follower-resynced"),
        makeTrack("lt-follower-host-selection"),
        makeTrack("lt-follower-after-host-selection"),
    ];
    listenTogetherSnapshot = {
        groupId: "lt-follower-fresh-host-media",
        isHost: false,
    };
    audioState.currentTrack = tracks[0];
    audioState.queue = tracks;

    renderOrchestrator();
    await flushAsync();

    await failPlayingTrack();
    await applyListenTogetherResume(tracks, 1);
    await failPlayingTrack();
    await applyListenTogetherResume(tracks, 2);

    await applyListenTogetherResume(tracks, 3);
    await failPlayingTrack();

    assert.deepEqual(listenTogetherResyncCalls, [
        "lt-follower-fresh-host-media",
        "lt-follower-fresh-host-media",
        "lt-follower-fresh-host-media",
    ]);
    assert.equal(
        loggerCalls.warn.some((args) =>
            String(args[0]).includes("circuit breaker tripped"),
        ),
        false,
    );
});

test("manual host selection overrides an outstanding error advance", async () => {
    mock.timers.enable();
    const tracks = [
        makeTrack("lt-overlap-error-source"),
        makeTrack("lt-overlap-auto-target"),
        makeTrack("lt-overlap-manual-target"),
        makeTrack("lt-overlap-after-manual"),
        makeTrack("lt-overlap-unreached"),
    ];
    listenTogetherSnapshot = { groupId: "lt-overlap", isHost: true };
    audioState.currentTrack = tracks[0];
    audioState.queue = tracks;

    renderOrchestrator();
    await flushAsync();

    await failPlayingTrack();
    await applyManualListenTogetherSelection(tracks, 2);
    await failPlayingTrack();
    await applyListenTogetherResume(tracks, 3);
    await failPlayingTrack();

    assert.deepEqual(listenTogetherHostTrackOperations, [
        "next",
        "next",
        "next",
    ]);
    assert.equal(
        loggerCalls.warn.some((args) =>
            String(args[0]).includes("circuit breaker tripped"),
        ),
        false,
    );
});

test("manual listen-together track changes still reset prior failures", async () => {
    mock.timers.enable();
    const tracks = [
        makeTrack("lt-before-manual-1"),
        makeTrack("lt-before-manual-2"),
        makeTrack("lt-before-manual-3"),
        makeTrack("lt-manual-selection"),
        makeTrack("lt-after-manual"),
    ];
    listenTogetherSnapshot = { groupId: "lt-manual-reset", isHost: true };
    audioState.currentTrack = tracks[0];
    audioState.queue = tracks;

    renderOrchestrator();
    await flushAsync();

    for (let index = 0; index < 2; index += 1) {
        await failPlayingTrack();
        await applyListenTogetherResume(tracks, index + 1);
    }

    await applyManualListenTogetherSelection(tracks, 3);
    await failPlayingTrack();

    assert.deepEqual(listenTogetherHostTrackOperations, [
        "next",
        "next",
        "next",
    ]);
    assert.equal(
        loggerCalls.warn.some((args) =>
            String(args[0]).includes("circuit breaker tripped"),
        ),
        false,
    );
});

test("confirmed playback progress resets prior consecutive errors", async () => {
    mock.timers.enable();
    const tracks = [
        makeTrack("failed-before-progress-1"),
        makeTrack("failed-before-progress-2"),
        makeTrack("progress-then-failure"),
        makeTrack("next-after-progress"),
    ];
    audioState.currentTrack = tracks[0];
    audioState.queue = tracks;

    renderOrchestrator();
    await flushAsync();

    for (let index = 0; index < 2; index += 1) {
        await failPlayingTrack();
        selectTrack(tracks, index + 1);
        await flushAsync();
    }

    engine.emit("load", { durationSec: 210 });
    engine.playing = true;
    engine.emit("play");
    engine.emit("timeupdate", { timeSec: 0.5 });
    engine.emit("timeupdate", { timeSec: 1 });
    await emitFatalLoadError();
    mock.timers.tick(1_201);
    await flushAsync();

    assert.equal(controlCalls.next, 3);
});

test("foreground recovery directly advances an unhandled ended music track", async () => {
    const visibilityDocument = installVisibilityDocument();
    audioState.playbackType = null;
    audioState.currentTrack = null;
    audioState.queue = [];

    renderOrchestrator();
    await flushAsync();

    const endedTrack = makeTrack("background-ended");
    audioState.playbackType = "track";
    audioState.currentTrack = endedTrack;
    audioState.queue = [endedTrack, makeTrack("background-next")];
    playbackState.isPlaying = true;
    rerenderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.playing = true;
    engine.emit("play");
    await flushAsync();

    visibilityDocument.dispatchVisibility("hidden");
    engine.trackEnded = true;
    engine.playing = false;
    visibilityDocument.dispatchVisibility("visible");
    await flushAsync();

    assert.equal(controlCalls.next, 1);
    assert.equal(engine.notifyTrackEndedCalls, 0);
});

test("newly loaded source can end immediately after an advance", async () => {
    const tracks = [
        makeTrack("immediate-end-1"),
        makeTrack("immediate-end-2"),
        makeTrack("immediate-end-3"),
    ];
    audioState.currentTrack = tracks[0];
    audioState.queue = tracks;

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.emit("end");
    assert.equal(controlCalls.next, 1);

    audioState.currentTrack = tracks[1];
    audioState.currentIndex = 1;
    rerenderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.emit("end");

    assert.equal(controlCalls.next, 2);
});

test("late Auto Match continuation advances from the rerendered shuffled queue", async () => {
    let commitQueueMutation!: (mutation: VibeQueueMutationKind) => void;
    let resolveVibe!: (result: {
        success: boolean;
        trackCount: number;
    }) => void;
    startVibeModeImpl = (options) =>
        new Promise((resolve) => {
            commitQueueMutation = (mutation) => {
                if (!options?.queueCommitToken) return;
                options.onLocalQueueCommit?.({
                    token: options.queueCommitToken,
                    mutation,
                });
            };
            resolveVibe = resolve;
        });
    const seed = makeTrack("late-vibe-seed", {
        streamSource: "youtube",
        youtubeVideoId: "AAAAAAAAAAA",
    });
    audioState.queue = [makeTrack("played-0"), seed, makeTrack("played-2")];
    audioState.currentTrack = seed;
    audioState.currentIndex = 1;
    audioState.isShuffle = true;
    audioState.shuffleIndices = [2, 0, 1];

    renderOrchestrator();
    await flushAsync();
    assert.equal(controlCalls.startVibeMode, 1);
    engine.emit("load", { durationSec: 210 });
    engine.emit("end");
    await flushAsync();
    assert.equal(controlCalls.next, 0);

    commitQueueMutation("append");
    audioState.queue = [...audioState.queue, makeTrack("provider-next")];
    audioState.shuffleIndices = [2, 0, 1, 3];
    rerenderOrchestrator();
    await flushAsync();
    assert.equal(controlCalls.next, 0);

    resolveVibe({ success: true, trackCount: 1 });
    await flushAsync();
    assert.equal(controlCalls.next, 1);
});

test("late Audio-DNA continuation advances after replacing a longer queue", async () => {
    let commitQueueMutation!: (mutation: VibeQueueMutationKind) => void;
    let resolveVibe!: (result: {
        success: boolean;
        trackCount: number;
    }) => void;
    startVibeModeImpl = (options) =>
        new Promise((resolve) => {
            commitQueueMutation = (mutation) => {
                if (!options?.queueCommitToken) return;
                options.onLocalQueueCommit?.({
                    token: options.queueCommitToken,
                    mutation,
                });
            };
            resolveVibe = resolve;
        });
    const originalQueue = Array.from({ length: 60 }, (_, index) =>
        makeTrack(`long-queue-${index}`),
    );
    const seed = originalQueue[59];
    audioState.queue = originalQueue;
    audioState.currentTrack = seed;
    audioState.currentIndex = 59;

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.emit("end");
    await flushAsync();

    commitQueueMutation("replace");
    audioState.queue = [
        seed,
        ...Array.from({ length: 50 }, (_, index) =>
            makeTrack(`dna-next-${index}`),
        ),
    ];
    audioState.currentIndex = 0;
    rerenderOrchestrator();
    await flushAsync();

    assert.equal(controlCalls.next, 0);
    resolveVibe({ success: true, trackCount: 50 });
    await flushAsync();
    assert.equal(controlCalls.next, 1);
});

test("late Auto Match continuation does not advance a manually selected duplicate track", async () => {
    let resolveVibe!: (result: {
        success: boolean;
        trackCount: number;
    }) => void;
    startVibeModeImpl = () =>
        new Promise((resolve) => {
            resolveVibe = resolve;
        });
    const earlierDuplicate = makeTrack("duplicate-vibe-seed", {
        title: "Earlier occurrence",
    });
    const endingDuplicate = makeTrack("duplicate-vibe-seed", {
        title: "Ending occurrence",
    });
    audioState.queue = [
        earlierDuplicate,
        makeTrack("played-middle"),
        endingDuplicate,
    ];
    audioState.currentTrack = endingDuplicate;
    audioState.currentIndex = 2;

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.emit("end");
    await flushAsync();
    assert.equal(controlCalls.next, 0);

    audioState.queue = [...audioState.queue];
    audioState.currentTrack = earlierDuplicate;
    audioState.currentIndex = 0;
    rerenderOrchestrator();
    await flushAsync();

    resolveVibe({ success: false, trackCount: 0 });
    await flushAsync();
    assert.equal(controlCalls.next, 0);
});

test("successful late Auto Match cannot adopt a manually selected duplicate in a replaced queue", async () => {
    let reportForeignQueueCommit!: () => void;
    let resolveVibe!: (result: {
        success: boolean;
        trackCount: number;
    }) => void;
    startVibeModeImpl = (options) =>
        new Promise((resolve) => {
            reportForeignQueueCommit = () => {
                options?.onLocalQueueCommit?.({
                    token: {},
                    mutation: "replace",
                });
            };
            resolveVibe = resolve;
        });
    const earlierDuplicate = makeTrack("duplicate-success-seed", {
        title: "Earlier occurrence",
    });
    const endingDuplicate = makeTrack("duplicate-success-seed", {
        title: "Ending occurrence",
    });
    audioState.queue = [
        earlierDuplicate,
        makeTrack("success-middle"),
        endingDuplicate,
    ];
    audioState.currentTrack = endingDuplicate;
    audioState.currentIndex = 2;

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.emit("end");
    await flushAsync();

    audioState.queue = [...audioState.queue];
    audioState.currentTrack = earlierDuplicate;
    audioState.currentIndex = 0;
    rerenderOrchestrator();
    await flushAsync();

    reportForeignQueueCommit();
    resolveVibe({ success: true, trackCount: 1 });
    await flushAsync();
    assert.equal(controlCalls.next, 0);
});

test("late Auto Match resolution cannot advance after the player unmounts", async () => {
    let resolveVibe!: (result: {
        success: boolean;
        trackCount: number;
    }) => void;
    startVibeModeImpl = () =>
        new Promise((resolve) => {
            resolveVibe = resolve;
        });
    const seed = makeTrack("unmounted-vibe-seed");
    audioState.queue = [seed];
    audioState.currentTrack = seed;
    audioState.currentIndex = 0;

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.emit("end");
    await flushAsync();

    hookRuntime.unmount();
    resolveVibe({ success: false, trackCount: 0 });
    await flushAsync();

    assert.equal(controlCalls.next, 0);
});

test("unrelated queue replacement does not satisfy a pending Auto Match request", async () => {
    advanceQueueRequiresCapturedNext = true;
    let resolveVibe!: (result: {
        success: boolean;
        trackCount: number;
    }) => void;
    startVibeModeImpl = () =>
        new Promise((resolve) => {
            resolveVibe = resolve;
        });
    const seed = makeTrack("pending-vibe-seed", {
        streamSource: "youtube",
        youtubeVideoId: "BBBBBBBBBBB",
    });
    audioState.queue = [seed];
    audioState.currentTrack = seed;
    audioState.currentIndex = 0;

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.emit("end");
    await flushAsync();

    audioState.queue = [seed, makeTrack("manually-added")];
    rerenderOrchestrator();
    await flushAsync();
    assert.equal(controlCalls.next, 0);

    resolveVibe({ success: false, trackCount: 0 });
    await flushAsync();
    assert.equal(controlCalls.next, 1);
});

test("keeps engine end listeners attached across playback state churn", async () => {
    const tracks = [makeTrack("stable-1"), makeTrack("stable-2")];
    audioState.currentTrack = tracks[0];
    audioState.queue = tracks;
    audioState.repeatMode = "one";

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    await flushAsync();

    const stableEvents = ["timeupdate", "end", "playerror", "play", "pause"];
    const beforeChurn = stableEvents.map((event) => ({
        event,
        on: engine.onCalls.filter((call) => call.event === event).length,
        off: engine.offCalls.filter((call) => call.event === event).length,
    }));

    playbackState.isPlaying = true;
    audioState.repeatMode = "off";
    rerenderOrchestrator();
    engine.emit("end");

    assert.equal(controlCalls.next, 1);
    assert.deepEqual(
        stableEvents.map((event) => ({
            event,
            on: engine.onCalls.filter((call) => call.event === event).length,
            off: engine.offCalls.filter((call) => call.event === event).length,
        })),
        beforeChurn,
    );
});

test("track-end watchdog advances after a lost end event and emits server telemetry", async () => {
    mock.timers.enable();
    enableWindowMetrics();
    playbackState.isPlaying = true;
    const track = makeTrack("watchdog-ended");
    audioState.currentTrack = track;
    audioState.queue = [track, makeTrack("watchdog-next")];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.playing = true;
    engine.emit("play");
    engine.duration = 210;
    engine.currentTime = 209.8;
    engine.actualCurrentTime = 209.8;
    engine.emit("timeupdate", { timeSec: 209.8 });

    engine.playing = false;
    engine.trackEnded = true;
    mock.timers.tick(1_999);
    assert.equal(controlCalls.next, 0);
    mock.timers.tick(1);
    await flushAsync();

    assert.equal(controlCalls.next, 1);
    const signals = getServerSignalEvents("player.track_end_advanced");
    assert.equal(signals.length, 1);
    assert.deepEqual(signals[0]?.fields, {
        engineMode: "howler",
        activeEngine: "howler",
        trackId: "watchdog-ended",
        viaWatchdog: true,
    });
});

test("normal end handling cancels the watchdog and advances only once", async () => {
    mock.timers.enable();
    playbackState.isPlaying = true;
    const track = makeTrack("handled-before-watchdog");
    audioState.currentTrack = track;
    audioState.queue = [track, makeTrack("handled-next")];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.playing = true;
    engine.emit("play");
    engine.duration = 210;
    engine.currentTime = 209.8;
    engine.emit("timeupdate", { timeSec: 209.8 });
    engine.emit("end");

    engine.playing = false;
    engine.trackEnded = true;
    mock.timers.tick(2_000);
    await flushAsync();

    assert.equal(controlCalls.next, 1);
});

test("pause clears an armed track-end watchdog", async () => {
    mock.timers.enable();
    playbackState.isPlaying = true;
    const track = makeTrack("paused-near-end");
    audioState.currentTrack = track;
    audioState.queue = [track, makeTrack("paused-next")];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.playing = true;
    engine.emit("play");
    engine.duration = 210;
    engine.currentTime = 209.8;
    engine.emit("timeupdate", { timeSec: 209.8 });
    engine.emit("pause");

    engine.playing = false;
    engine.trackEnded = true;
    mock.timers.tick(2_000);
    await flushAsync();

    assert.equal(controlCalls.next, 0);
});

test("reports rejected and normally advanced track ends to the server", async () => {
    enableWindowMetrics();
    const track = makeTrack("telemetry-end");
    audioState.currentTrack = track;
    audioState.queue = [track, makeTrack("telemetry-next")];

    renderOrchestrator();
    engine.emit("end");
    await flushAsync();

    const rejected = getServerSignalEvents("player.track_end_rejected");
    assert.equal(rejected.length, 1);
    assert.deepEqual(rejected[0]?.fields, {
        engineMode: "howler",
        activeEngine: "howler",
        reason: "engine_source_loading",
        currentTrackId: "telemetry-end",
        activeEngineTrackId: null,
        activeLoadId: -1,
    });

    engine.emit("load", { durationSec: 210 });
    engine.emit("end");
    await flushAsync();

    const advanced = getServerSignalEvents("player.track_end_advanced");
    assert.equal(advanced.length, 1);
    assert.deepEqual(advanced[0]?.fields, {
        engineMode: "howler",
        activeEngine: "howler",
        trackId: "telemetry-end",
        viaWatchdog: false,
    });

    engine.emit("end");
    await flushAsync();

    const duplicateRejected = getServerSignalEvents(
        "player.track_end_rejected",
    );
    assert.equal(duplicateRejected.length, 2);
    assert.deepEqual(duplicateRejected[1]?.fields, {
        engineMode: "howler",
        activeEngine: "howler",
        reason: "duplicate_end",
        currentTrackId: "telemetry-end",
        activeEngineTrackId: "telemetry-end",
        activeLoadId: 1,
    });
});

test("startup playback watchdog does not reload for a listen-together follower", async () => {
    mock.timers.enable();
    playbackState.isPlaying = true;
    listenTogetherSnapshot = {
        groupId: "lt-startup-follower",
        isHost: false,
    };
    const track = makeTrack("lt-startup-track");
    audioState.currentTrack = track;
    audioState.queue = [track];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    await flushAsync();

    mock.timers.tick(1_500);
    await flushAsync();

    assert.equal(engine.reloadCalls, 0);
});

test("natural queue advance preserves autoplay intent across load-before-play ordering", async () => {
    enableWindowMetrics();
    mirrorMachineIntentToPlaybackState = true;
    playbackState.isPlaying = true;
    const firstTrack = makeTrack("advance-intent-1", {
        streamSource: "youtube",
        youtubeVideoId: "advance-intent-video-1",
    });
    const nextTrack = makeTrack("advance-intent-2", {
        streamSource: "youtube",
        youtubeVideoId: "advance-intent-video-2",
    });
    audioState.currentTrack = firstTrack;
    audioState.queue = [firstTrack, nextTrack];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.emit("play");
    await flushAsync();
    assert.equal(playbackMachine.state, "PLAYING");
    assert.equal(engine.preloadCalls.length, 0);

    engine.emit("end");
    await flushAsync();
    assert.equal(controlCalls.next, 1);
    assert.deepEqual(engine.preloadCalls, [
        {
            url: "https://stream.test/yt/advance-intent-video-2",
            format: "mp4",
        },
    ]);

    audioState.currentTrack = nextTrack;
    audioState.currentIndex = 1;
    rerenderOrchestrator();
    await flushAsync();

    const pauseCallsBeforeLoad = engine.pauseCalls;
    engine.emit("load", { durationSec: 210 });
    await flushAsync();
    rerenderOrchestrator();
    await flushAsync();

    assert.equal(engine.pauseCalls, pauseCallsBeforeLoad);
    assert.equal(playbackState.isPlaying, true);
    engine.emit("play");
    await flushAsync();
    assert.equal(playbackMachine.state, "PLAYING");
    const advanceDecision = getServerSignalEvents(
        "player.load_autoplay_decision",
    ).find(
        (event) =>
            (event.fields as Record<string, unknown> | undefined)?.loadId === 2,
    );
    const advanceDecisionFields = advanceDecision?.fields as
        | Record<string, unknown>
        | undefined;
    assert.equal(advanceDecisionFields?.hasAdvancePlayIntent, true);
    assert.equal(advanceDecisionFields?.shouldAutoPlayOnLoad, true);
});

test("manual paused load lands ready without autoplay", async () => {
    mirrorMachineIntentToPlaybackState = true;
    playbackState.isPlaying = false;
    audioState.currentTrack = makeTrack("manual-paused-load");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();
    assert.equal(engine.loadCalls[0]?.args[1], false);

    engine.emit("load", { durationSec: 210 });
    await flushAsync();

    assert.equal(playbackMachine.state, "READY");
    assert.equal(playbackState.isPlaying, false);
    assert.equal(engine.playCalls, 0);
});

test("deferred autoplay seeks then reasserts play intent", async () => {
    enableWindowMetrics();
    mirrorMachineIntentToPlaybackState = true;
    playbackState.isPlaying = true;
    audioState.playbackType = "audiobook";
    audioState.currentTrack = null;
    audioState.currentAudiobook = {
        id: "deferred-audiobook",
        duration: 900,
        progress: { currentTime: 37 },
    };
    audioState.queue = [];

    renderOrchestrator();
    await flushAsync();
    assert.equal(engine.loadCalls[0]?.args[1], false);

    engine.emit("load", { durationSec: 900 });
    await flushAsync();
    rerenderOrchestrator();
    await flushAsync();

    assert.ok(engine.seekCalls.includes(37));
    assert.ok(engine.playCalls >= 1);
    assert.ok(playbackCalls.setIsPlaying.includes(true));
    assert.equal(playbackState.isPlaying, true);
    assert.equal(engine.pauseCalls, 0);
    engine.emit("play");
    await flushAsync();
    assert.equal(playbackMachine.state, "PLAYING");
    const [decision] = getServerSignalEvents("player.load_autoplay_decision");
    const decisionFields = decision?.fields as
        | Record<string, unknown>
        | undefined;
    assert.equal(decisionFields?.deferAutoplay, true);
    assert.equal(decisionFields?.shouldAutoPlayOnLoad, true);
    assert.equal(decisionFields?.startTime, 37);
});

test("user pause during autoplay loading clears the load play intent", async () => {
    mirrorMachineIntentToPlaybackState = true;
    playbackState.isPlaying = true;
    audioState.currentTrack = makeTrack("pause-during-load");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();
    assert.equal(engine.loadCalls[0]?.args[1], true);

    playbackState.isPlaying = false;
    rerenderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    await flushAsync();

    assert.equal(playbackMachine.state, "READY");
    assert.equal(playbackState.isPlaying, false);
    assert.equal(engine.playCalls, 0);
});

test("listen-together follower load never autoplays from local intent", async () => {
    mirrorMachineIntentToPlaybackState = true;
    playbackState.isPlaying = true;
    listenTogetherSnapshot = {
        groupId: "lt-load-follower",
        isHost: false,
    };
    audioState.currentTrack = makeTrack("lt-follower-load");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();
    assert.equal(engine.loadCalls[0]?.args[1], false);

    engine.emit("load", { durationSec: 210 });
    await flushAsync();

    assert.equal(playbackMachine.state, "READY");
    assert.equal(playbackState.isPlaying, false);
    assert.equal(engine.playCalls, 0);
});

test("reports one server-visible autoplay decision per load", async () => {
    enableWindowMetrics();
    playbackState.isPlaying = true;
    audioState.currentTrack = makeTrack("autoplay-decision");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();

    const decisions = getServerSignalEvents("player.load_autoplay_decision");
    assert.equal(decisions.length, 1);
    assert.deepEqual(decisions[0]?.fields, {
        engineMode: "howler",
        activeEngine: "howler",
        loadId: 1,
        shouldAutoPlayOnLoad: true,
        deferAutoplay: false,
        hasAdvancePlayIntent: false,
        wasPlayingBeforeLoad: true,
        startTime: 0,
    });
});

test("reports an autoplay intent conflict before sync-pausing a playing engine", async () => {
    enableWindowMetrics();
    playbackState.isPlaying = true;
    audioState.currentTrack = makeTrack("autoplay-conflict");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.emit("play");
    await flushAsync();

    playbackState.isPlaying = false;
    rerenderOrchestrator();
    await flushAsync();

    const conflicts = getServerSignalEvents("player.autoplay_intent_conflict");
    assert.equal(conflicts.length, 1);
    assert.deepEqual(conflicts[0]?.fields, {
        engineMode: "howler",
        activeEngine: "howler",
        loadId: 1,
    });
    assert.equal(engine.pauseCalls, 1);
});

test("loads direct track, applies output state, and syncs play/pause transitions", async () => {
    playbackState.isPlaying = true;
    audioState.currentTrack = makeTrack("direct-track", {
        filePath: "direct-track.flac",
    });
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();

    assert.equal(engine.loadCalls.length, 1);
    const [source, autoplay, format] = engine.loadCalls[0].args;
    assert.equal(source, "https://stream.test/direct/direct-track");
    assert.equal(autoplay, true);
    assert.equal(format, "flac");
    assert.ok(playbackCalls.setDuration.includes(210));
    assert.ok(
        playbackCalls.setStreamProfile.some((profile) =>
            Boolean(
                profile &&
                typeof profile === "object" &&
                "mode" in profile &&
                (profile as { mode: string }).mode === "direct",
            ),
        ),
    );

    engine.emit("load", { durationSec: 210 });
    await flushAsync();
    assert.ok(engine.playCalls >= 1);
    assert.ok(engine.setVolumeCalls.length > 0);
    assert.ok(engine.setMutedCalls.length > 0);

    playbackState.isPlaying = false;
    rerenderOrchestrator();
    await flushAsync();
    assert.ok(engine.pauseCalls >= 1);

    playbackState.isPlaying = true;
    rerenderOrchestrator();
    await flushAsync();
    assert.ok(engine.playCalls >= 2);
});

test("native engine startup reaches the client-signal pipeline with neutral telemetry naming", async () => {
    enableWindowMetrics();
    runtimeEngineMode = "native";
    playbackState.isPlaying = true;
    audioState.currentTrack = makeTrack("native-startup");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    await flushAsync();

    const startupSignals = getServerSignalEvents("player.engine_startup");
    assert.equal(startupSignals.length, 1);
    const startupFields = startupSignals[0]?.fields as
        | Record<string, unknown>
        | undefined;
    assert.ok(startupFields);
    const durationMs = startupFields.durationMs;
    assert.equal(typeof durationMs, "number");
    assert.ok(typeof durationMs === "number" && Number.isFinite(durationMs));
    assert.deepEqual(startupSignals[0]?.fields, {
        engineMode: "native",
        activeEngine: "native",
        durationMs,
        trackId: "native-startup",
        sourceType: "local",
        playbackType: "track",
    });
    assert.equal(getServerSignalEvents("player.howler_startup").length, 0);
});

test("preempts in-flight load when track switches before initial load settles", async () => {
    playbackState.isPlaying = false;
    audioState.currentTrack = makeTrack("track-a");
    audioState.queue = [audioState.currentTrack, makeTrack("track-b")];

    renderOrchestrator();
    await flushAsync();
    assert.equal(engine.loadCalls.length, 1);

    audioState.currentTrack = makeTrack("track-b");
    audioState.queue = [audioState.currentTrack];
    rerenderOrchestrator();
    await flushAsync();

    assert.equal(engine.loadCalls.length, 2);
    const [secondSource] = engine.loadCalls[1].args;
    assert.equal(secondSource, "https://stream.test/direct/track-b");
    assert.ok(engine.stopCalls >= 1);
    assert.ok(engine.offCalls.some((call) => call.event === "load"));
    assert.ok(engine.offCalls.some((call) => call.event === "loaderror"));
    assert.ok(
        preemptChecks.some(
            (check) =>
                check.currentMediaId === "track-b" &&
                check.previousMediaId === "track-a" &&
                check.isLoading === true,
        ),
    );
});

test("preempts an in-flight load when a duplicate playlist occurrence is selected", async () => {
    playbackState.isPlaying = false;
    const firstOccurrence = makeTrack("duplicate-track", {
        playlistItemId: "playlist-item-a",
    });
    const secondOccurrence = makeTrack("duplicate-track", {
        playlistItemId: "playlist-item-b",
    });
    audioState.currentTrack = firstOccurrence;
    audioState.queue = [firstOccurrence, secondOccurrence];
    audioState.currentIndex = 0;

    renderOrchestrator();
    await flushAsync();
    assert.equal(engine.loadCalls.length, 1);

    audioState.currentTrack = secondOccurrence;
    audioState.currentIndex = 1;
    rerenderOrchestrator();
    await flushAsync();

    assert.equal(engine.loadCalls.length, 2);
    assert.equal(
        engine.loadCalls[1]?.args[0],
        "https://stream.test/direct/duplicate-track",
    );
    assert.ok(engine.stopCalls >= 1);
});

test("podcast cached seek falls back to reload when direct seek misses target", async () => {
    mock.timers.enable();

    audioState.playbackType = "podcast";
    audioState.currentTrack = null;
    audioState.currentPodcast = {
        id: "pod-1:ep-1",
        title: "Episode 1",
        duration: 1800,
        progress: { currentTime: 30 },
    };
    audioState.queue = [];
    playbackState.isPlaying = false;
    podcastCacheStatus = {
        cached: true,
        downloading: false,
        downloadProgress: null,
    };
    seekToleranceOverride = false;
    engine.playing = true;
    engine.currentTime = 0;
    engine.actualCurrentTime = 0;

    renderOrchestrator();
    await flushAsync(10);

    emitSeek(120);
    await flushAsync(10);
    assert.ok(engine.seekCalls.includes(120));

    mock.timers.tick(150);
    await flushAsync(8);
    assert.equal(engine.reloadCalls, 1);

    engine.emit("load", { durationSec: 1800 });
    await flushAsync(8);
    assert.ok(engine.seekCalls.filter((value) => value === 120).length >= 2);
    assert.ok(engine.playCalls >= 1);
    assert.ok(playbackCalls.setIsPlaying.includes(true));
});

test("unmount cleanup stops engine and detaches listeners", async () => {
    playbackState.isPlaying = false;
    audioState.currentTrack = makeTrack("cleanup-track");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();

    const onListenerCount = engine.onCalls.length;
    assert.ok(onListenerCount > 0);

    hookRuntime.unmount();

    assert.ok(engine.stopCalls >= 1);
    assert.ok(engine.offCalls.length > 0);
});

test("remote Wave completion sends one contextual engagement update", async () => {
    playbackState.isPlaying = true;
    audioState.vibeMode = true;
    audioState.waveMode = "new";
    audioState.currentTrack = makeTrack("yt:wave-track", {
        streamSource: "youtube",
        youtubeVideoId: "wave-track",
        artist: { name: "Artist" },
        album: { title: "Album" },
        duration: 100,
    });
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync(8);
    engine.emit("load", { durationSec: 100 });
    engine.playing = true;
    engine.emit("play");
    engine.emit("timeupdate", { timeSec: 0 });
    engine.emit("timeupdate", { timeSec: 5 });
    engine.emit("timeupdate", { timeSec: 10 });
    engine.emit("end");
    engine.emit("end");
    await flushAsync(12);

    assert.equal(apiCalls.logPlay.length, 1);
    assert.deepEqual(apiCalls.logPlay[0]?.context, {
        playContext: "wave",
        waveMode: "new",
    });
    assert.deepEqual(apiCalls.updatePlayEngagement, [
        {
            playId: "play-1",
            input: {
                listenedSeconds: 10,
                completionRatio: 1,
                outcome: "completed",
            },
        },
    ]);
});

test("remote track change finalizes an early listen as skipped once", async () => {
    playbackState.isPlaying = true;
    const first = makeTrack("yt:first-track", {
        streamSource: "youtube",
        youtubeVideoId: "first-track",
        artist: { name: "Artist" },
        album: { title: "Album" },
        duration: 200,
    });
    audioState.currentTrack = first;
    audioState.queue = [first];

    renderOrchestrator();
    await flushAsync(8);
    engine.emit("timeupdate", { timeSec: 0 });
    engine.emit("timeupdate", { timeSec: 8 });

    const second = makeTrack("yt:second-track", {
        streamSource: "youtube",
        youtubeVideoId: "second-track",
        artist: { name: "Artist" },
        album: { title: "Album" },
        duration: 200,
    });
    audioState.currentTrack = second;
    audioState.queue = [second];
    rerenderOrchestrator();
    await flushAsync(12);

    assert.deepEqual(apiCalls.updatePlayEngagement, [
        {
            playId: "play-1",
            input: {
                listenedSeconds: 8,
                completionRatio: 0.04,
                outcome: "skipped",
            },
        },
    ]);
});

test("adjacent duplicate remote occurrences create separate play sessions", async () => {
    playbackState.isPlaying = true;
    const duplicate = makeTrack("yt:duplicate-track", {
        streamSource: "youtube",
        youtubeVideoId: "duplicate-track",
        artist: { name: "Artist" },
        album: { title: "Album" },
        duration: 200,
    });
    audioState.currentTrack = duplicate;
    audioState.queue = [duplicate, { ...duplicate }];
    audioState.currentIndex = 0;

    renderOrchestrator();
    await flushAsync(8);
    engine.emit("timeupdate", { timeSec: 0 });
    engine.emit("timeupdate", { timeSec: 5 });

    audioState.currentTrack = { ...duplicate };
    audioState.currentIndex = 1;
    rerenderOrchestrator();
    await flushAsync(12);

    assert.equal(apiCalls.logPlay.length, 2);
    assert.deepEqual(apiCalls.updatePlayEngagement, [
        {
            playId: "play-1",
            input: {
                listenedSeconds: 5,
                completionRatio: 0.025,
                outcome: "skipped",
            },
        },
    ]);
});

test("fatal remote playback error finalizes engagement as failed", async () => {
    playbackState.isPlaying = true;
    audioState.currentTrack = makeTrack("tidal:42", {
        streamSource: "tidal",
        tidalTrackId: 42,
        artist: { name: "Artist" },
        album: { title: "Album" },
        duration: 200,
    });
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync(8);
    engine.emit("load", { durationSec: 200 });
    engine.playing = true;
    engine.emit("play");
    engine.emit("timeupdate", { timeSec: 0 });
    engine.emit("timeupdate", { timeSec: 5 });
    engine.emit("playerror", {
        error: new Error("decoder rejected stream"),
        code: "3",
        recoverable: false,
    });
    await flushAsync(12);

    assert.deepEqual(apiCalls.updatePlayEngagement, [
        {
            playId: "play-1",
            input: {
                listenedSeconds: 5,
                completionRatio: 0.025,
                outcome: "failed",
            },
        },
    ]);
});

test("keeps track time snapshot id null when track playback has no active track", async () => {
    audioState.playbackType = "track";
    audioState.currentTrack = null;
    audioState.queue = [];
    playbackState.currentTime = 37;

    renderOrchestrator();
    await flushAsync(8);

    assert.equal(engine.loadCalls.length, 0);
    assert.ok(playbackCalls.setDuration.includes(0));
});

test("podcast progress save falls back to podcast duration when engine duration is zero", async () => {
    audioState.playbackType = "podcast";
    audioState.currentTrack = null;
    audioState.currentPodcast = {
        id: "podcast-9:episode-2",
        duration: 1800,
        progress: { currentTime: 15 },
    };
    audioState.queue = [];
    playbackState.isPlaying = false;
    playbackState.isBuffering = false;
    engine.currentTime = 42;
    engine.actualCurrentTime = 42;
    engine.duration = 0;

    renderOrchestrator();
    await flushAsync(12);

    assert.ok(apiCalls.updatePodcastProgress.length >= 1);
    const saveCall = apiCalls.updatePodcastProgress[0];
    assert.equal(saveCall.podcastId, "podcast-9");
    assert.equal(saveCall.episodeId, "episode-2");
    assert.equal(saveCall.positionSec, 42);
    assert.equal(saveCall.durationSec, 1800);
    assert.equal(saveCall.isFinished, false);
});

test("preempting an in-flight load clears seek-reload load listener", async () => {
    mock.timers.enable();

    audioState.playbackType = "podcast";
    audioState.currentTrack = null;
    audioState.currentPodcast = {
        id: "pod-preempt:ep-1",
        title: "Preempt Episode",
        duration: 1500,
        progress: { currentTime: 0 },
    };
    audioState.queue = [];
    playbackState.isPlaying = false;
    podcastCacheStatus = {
        cached: true,
        downloading: false,
        downloadProgress: null,
    };
    seekToleranceOverride = false;
    engine.playing = true;
    engine.currentTime = 0;
    engine.actualCurrentTime = 0;

    renderOrchestrator();
    await flushAsync(10);
    emitSeek(120);
    await flushAsync(10);
    mock.timers.tick(150);
    await flushAsync(8);
    assert.equal(engine.reloadCalls, 1);

    const loadOffBefore = engine.offCalls.filter(
        (call) => call.event === "load",
    ).length;

    audioState.playbackType = "track";
    audioState.currentPodcast = null;
    audioState.currentTrack = makeTrack("post-seek-track");
    audioState.queue = [audioState.currentTrack];
    rerenderOrchestrator();
    await flushAsync(12);

    const loadOffAfter = engine.offCalls.filter(
        (call) => call.event === "load",
    ).length;
    assert.ok(loadOffAfter - loadOffBefore >= 2);
});

test("startup watchdog reloads when the engine plays without any progress", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    audioState.currentTrack = makeTrack("frozen-startup-track");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    await flushAsync();

    // Engine claims to play, but no timeupdate ever arrives: frozen time.
    engine.playing = true;
    assert.equal(engine.reloadCalls, 0);

    t.mock.timers.tick(1_400);
    await flushAsync();
    t.mock.timers.tick(900);
    await flushAsync();
    t.mock.timers.tick(900);
    await flushAsync();

    assert.equal(engine.reloadCalls, 1);
});

test("startup watchdog leaves healthy playback with real progress alone", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    audioState.currentTrack = makeTrack("healthy-startup-track");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    await flushAsync();

    engine.playing = true;
    engine.currentTime = 0.6;
    engine.actualCurrentTime = 0.6;
    engine.emit("timeupdate", { timeSec: 0.6 });
    await flushAsync();
    engine.emit("timeupdate", { timeSec: 1.4 });
    await flushAsync();

    t.mock.timers.tick(1_400);
    await flushAsync();
    t.mock.timers.tick(900);
    await flushAsync();
    t.mock.timers.tick(900);
    await flushAsync();

    assert.equal(engine.reloadCalls, 0);
});

test("early unexpected stop is suppressed and routed to startup recovery", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    audioState.currentTrack = makeTrack("early-stop-track");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    await flushAsync();

    // No startup progress yet; the engine stops claiming playback.
    engine.playing = false;
    assert.equal(heartbeatInstances.length, 1);
    heartbeatInstances[0].triggerUnexpectedStop();
    await flushAsync();

    // Suppressed: play intent is preserved instead of being cleared.
    assert.equal(playbackCalls.setIsPlaying.includes(false), false);

    // The scheduled startup recovery reloads the frozen load.
    t.mock.timers.tick(1_400);
    await flushAsync();
    t.mock.timers.tick(900);
    await flushAsync();
    t.mock.timers.tick(900);
    await flushAsync();
    assert.equal(engine.reloadCalls, 1);
});

test("load timeout retries once and then fails playback", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    audioState.currentTrack = makeTrack("timeout-track");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();
    assert.equal(engine.loadCalls.length, 1);

    // First timeout: bounded retry re-issues the load.
    t.mock.timers.tick(20_000);
    await flushAsync();
    t.mock.timers.tick(350);
    await flushAsync();
    assert.equal(engine.loadCalls.length, 2);

    // Second timeout: retry budget exhausted → explicit error state.
    t.mock.timers.tick(20_000);
    await flushAsync();
    assert.equal(playbackMachine.state, "ERROR");
    assert.ok(playbackCalls.setIsPlaying.includes(false));
    assert.ok(playbackCalls.setIsBuffering.includes(false));
});

test("multi-track load timeout skips the failed track after one retry", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    const failedTrack = makeTrack("timeout-queue-track");
    audioState.currentTrack = failedTrack;
    audioState.queue = [failedTrack, makeTrack("timeout-queue-next")];

    renderOrchestrator();
    await flushAsync();

    t.mock.timers.tick(20_000);
    await flushAsync();
    t.mock.timers.tick(350);
    await flushAsync();
    t.mock.timers.tick(20_000);
    await flushAsync();
    t.mock.timers.tick(1_201);
    await flushAsync();

    assert.equal(engine.loadCalls.length, 2);
    assert.equal(controlCalls.next, 1);
});

test("load timeout advances with the queue callback committed while loading", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    advanceQueueRequiresCapturedNext = true;
    playbackState.isPlaying = true;
    const failedTrack = makeTrack("timeout-live-queue-track");
    audioState.currentTrack = failedTrack;
    audioState.queue = [failedTrack];

    renderOrchestrator();
    await flushAsync();

    audioState.queue = [failedTrack, makeTrack("timeout-live-queue-next")];
    rerenderOrchestrator();
    await flushAsync();

    t.mock.timers.tick(20_000);
    await flushAsync();
    t.mock.timers.tick(350);
    await flushAsync();
    t.mock.timers.tick(20_000);
    await flushAsync();
    t.mock.timers.tick(1_201);
    await flushAsync();

    assert.equal(controlCalls.next, 1);
});

test("cold YouTube Music spools stop after one bounded 135-second load window", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    const failedTrack = makeTrack("provider-timeout-track", {
        streamSource: "youtube",
        youtubeVideoId: "kXYiU_JCYtU",
    });
    audioState.currentTrack = failedTrack;
    audioState.queue = [failedTrack, makeTrack("provider-timeout-next")];

    renderOrchestrator();
    await flushAsync();

    t.mock.timers.tick(20_000);
    await flushAsync();
    assert.equal(engine.loadCalls.length, 1);
    assert.equal(engine.stopCalls, 0);

    t.mock.timers.tick(100_000);
    await flushAsync();
    assert.equal(engine.loadCalls.length, 1);
    assert.equal(engine.stopCalls, 0);

    t.mock.timers.tick(14_999);
    await flushAsync();
    assert.equal(engine.stopCalls, 0);

    t.mock.timers.tick(1);
    await flushAsync();
    assert.equal(engine.stopCalls, 1);

    const playCallsAfterTimeout = engine.playCalls;
    engine.emit("load", { durationSec: 210 });
    await flushAsync();
    assert.equal(engine.playCalls, playCallsAfterTimeout);

    t.mock.timers.tick(1_201);
    await flushAsync();
    assert.equal(controlCalls.next, 1);
});

test("engine-terminal network errors bypass outer transient recovery", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    const failedTrack = makeTrack("terminal-network-track");
    audioState.currentTrack = failedTrack;
    audioState.queue = [failedTrack, makeTrack("terminal-network-next")];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.playing = true;
    engine.emit("play");
    await flushAsync();

    engine.emit("playerror", {
        error: new Error("MEDIA_ERR_NETWORK"),
        code: "2",
        recoverable: false,
    });
    await flushAsync();
    t.mock.timers.tick(450);
    await flushAsync();
    assert.equal(engine.reloadCalls, 0);

    t.mock.timers.tick(751);
    await flushAsync();
    assert.equal(controlCalls.next, 1);
});

test("metadata load and play events do not reset transient retry budget", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    const failedTrack = makeTrack("flapping-stream-track");
    audioState.currentTrack = failedTrack;
    audioState.queue = [failedTrack, makeTrack("flapping-stream-next")];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.playing = true;
    engine.emit("play");
    await flushAsync();

    for (let attempt = 0; attempt < 4; attempt += 1) {
        engine.emit("playerror", {
            error: new Error("network connection reset"),
        });
        await flushAsync();
        t.mock.timers.tick(450);
        await flushAsync();
        engine.emit("load", { durationSec: 210 });
        engine.playing = true;
        engine.emit("play");
        await flushAsync();
    }

    engine.emit("playerror", {
        error: new Error("network connection reset"),
    });
    await flushAsync();
    t.mock.timers.tick(450);
    await flushAsync();
    assert.equal(engine.reloadCalls, 4);

    t.mock.timers.tick(751);
    await flushAsync();
    assert.equal(controlCalls.next, 1);
});

test("confirmed progress after a transient reload resets its retry budget", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    const recoveredTrack = makeTrack("recovered-stream-track");
    audioState.currentTrack = recoveredTrack;
    audioState.queue = [recoveredTrack, makeTrack("recovered-stream-next")];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.playing = true;
    engine.emit("play");
    engine.emit("timeupdate", { timeSec: 0 });
    engine.emit("timeupdate", { timeSec: 0.6 });
    await flushAsync();

    engine.emit("playerror", {
        error: new Error("network connection reset"),
    });
    await flushAsync();
    t.mock.timers.tick(450);
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    engine.playing = true;
    engine.emit("play");
    engine.emit("timeupdate", { timeSec: 1 });
    engine.emit("timeupdate", { timeSec: 1.6 });
    await flushAsync();

    for (let attempt = 0; attempt < 4; attempt += 1) {
        engine.emit("playerror", {
            error: new Error("network connection reset"),
        });
        await flushAsync();
        t.mock.timers.tick(450);
        await flushAsync();
        engine.emit("load", { durationSec: 210 });
        engine.playing = true;
        engine.emit("play");
        await flushAsync();
    }

    assert.equal(engine.reloadCalls, 5);
    assert.equal(controlCalls.next, 0);
});

test("transient playback errors reload the current track and resume", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    audioState.currentTrack = makeTrack("transient-error-track");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    await flushAsync();

    engine.emit("playerror", {
        error: new Error("network connection reset"),
    });
    await flushAsync();

    // Transient recovery holds the loading state rather than failing.
    assert.equal(playbackMachine.state, "LOADING");
    t.mock.timers.tick(450);
    await flushAsync();
    assert.equal(engine.reloadCalls, 1);

    // The reloaded source resumes playback via the correlated load handler.
    const playCallsBeforeResume = engine.playCalls;
    engine.playing = false;
    engine.emit("load", { durationSec: 210 });
    await flushAsync();
    assert.ok(engine.playCalls > playCallsBeforeResume);
});

test("transient YouTube errors retry the source before alternate lookup", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    const currentTrack = makeTrack("yt:transient01", {
        streamSource: "youtube",
        youtubeVideoId: "transient01",
    });
    audioState.currentTrack = currentTrack;
    audioState.queue = [currentTrack];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    await flushAsync();

    engine.emit("playerror", {
        error: new Error("network connection reset"),
    });
    await flushAsync();

    assert.equal(apiCalls.recoverUnavailableYtMusicTrack.length, 0);
    t.mock.timers.tick(450);
    await flushAsync();
    assert.equal(engine.reloadCalls, 1);
});

test("heartbeat stall buffers and buffer timeout runs transient recovery", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    audioState.currentTrack = makeTrack("stall-track");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    await flushAsync();
    engine.playing = true;
    engine.emit("timeupdate", { timeSec: 0.9 });
    await flushAsync();

    assert.equal(heartbeatInstances.length, 1);
    heartbeatInstances[0].triggerStall();
    await flushAsync();
    assert.equal(playbackMachine.state, "BUFFERING");
    assert.ok(playbackCalls.setIsBuffering.includes(true));

    // A buffer timeout is a hard connection failure, not a transient
    // stream error: playback fails explicitly instead of retrying.
    heartbeatInstances[0].triggerBufferTimeout();
    await flushAsync();
    assert.equal(engine.reloadCalls, 0);
    assert.equal(playbackMachine.state, "ERROR");
    assert.ok(playbackCalls.setIsPlaying.includes(false));
    assert.ok(playbackCalls.setIsBuffering.includes(false));
});

test("startup guard suppresses a second unexpected stop after progress begins", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    audioState.currentTrack = makeTrack("guarded-stop-track");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    await flushAsync();

    // First stop with no progress arms the startup guard window.
    engine.playing = false;
    assert.equal(heartbeatInstances.length, 1);
    heartbeatInstances[0].triggerUnexpectedStop();
    await flushAsync();

    // Playback then makes real progress inside the guard window.
    engine.playing = true;
    engine.currentTime = 0.6;
    engine.actualCurrentTime = 0.6;
    engine.emit("timeupdate", { timeSec: 0.6 });
    await flushAsync();
    engine.emit("timeupdate", { timeSec: 1.4 });
    await flushAsync();

    // A second stop inside the 20s guard is suppressed: play intent
    // survives and the machine is not forced to READY.
    const machineStateBefore = playbackMachine.state;
    engine.playing = false;
    heartbeatInstances[0].triggerUnexpectedStop();
    await flushAsync();

    assert.equal(playbackCalls.setIsPlaying.includes(false), false);
    assert.equal(playbackMachine.state, machineStateBefore);
});

test("transient recovery anchors resume to zero before startup progress", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    playbackState.isPlaying = true;
    audioState.currentTrack = makeTrack("stale-resume-track");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();
    engine.emit("load", { durationSec: 210 });
    await flushAsync();

    // The engine reports a stale position from a dying pipeline, but no
    // startup progress was ever observed for this track (no timeupdates).
    engine.currentTime = 12;
    engine.actualCurrentTime = 12;

    engine.emit("playerror", {
        error: new Error("network connection reset"),
    });
    await flushAsync();
    t.mock.timers.tick(450);
    await flushAsync();
    assert.equal(engine.reloadCalls, 1);

    // The recovered load must NOT seek back to the stale 12s position:
    // the startup guard forces the resume anchor to zero, and the
    // correlated-resume listener restarts playback.
    const playCallsBeforeRecoveredLoad = engine.playCalls;
    engine.playing = false;
    engine.emit("load", { durationSec: 210 });
    await flushAsync();

    assert.equal(engine.seekCalls.includes(12), false);
    assert.ok(engine.playCalls > playCallsBeforeRecoveredLoad);
});
