import {
    createAudioPreloadLease,
    type AudioPreloadLeaseController,
} from "./audioPreloadLease";
import type { ContinuousAudioSource } from "./continuousAudioBuffer";
import type {
    AudioEngine,
    AudioEngineSource,
    AudioEngineLoadOptions,
    AudioEngineEventType,
    AudioEngineEventHandler,
    AudioEngineEventPayloadMap,
    AudioPreloadLease,
} from "./types";

/** Continuous native timeline with caller-owned current/next recordings. */
export interface ContinuousTimeline {
    readonly url: string;
    readonly current: ContinuousAudioSource & {
        startSec: number;
        endSec: number | null;
    };
    pump(): Promise<void>;
    stage(source: ContinuousAudioSource): void;
    cancel(id: string): void;
    seek(position: number): Promise<void>;
    dispose(): void;
}

/** Browser transport ports, injected so queue intent can be tested independently. */
export interface ContinuousAudioEngineOptions {
    base: AudioEngine;
    prepare(
        source: AudioEngineSource,
        signal: AbortSignal,
    ): Promise<ContinuousAudioSource | null>;
    createTimeline(
        source: ContinuousAudioSource,
        callbacks: {
            readPosition(): number;
            onBoundary(id: string): void;
            onNextReady(id: string): void;
            onError(error: unknown): void;
        },
    ): ContinuousTimeline;
}

const events: AudioEngineEventType[] = [
    "load",
    "play",
    "pause",
    "stop",
    "end",
    "seek",
    "timeupdate",
    "volume",
    "buffering",
    "loaderror",
    "playerror",
    "error",
];
type LogicalSource = Omit<ContinuousAudioSource, "blob"> & { startSec: number };
const normalized = (source: AudioEngineSource | string): AudioEngineSource =>
    typeof source === "string" ? { url: source } : source;

/** Translates a continuous native stream into the existing per-track engine API. */
export class ContinuousAudioEngine implements AudioEngine {
    private timeline: ContinuousTimeline | null = null;
    private logical: LogicalSource | null = null;
    private loadAbort: AbortController | null = null;
    private preloadAbort: AbortController | null = null;
    private preloadController: AudioPreloadLeaseController | null = null;
    private preloadId: string | null = null;
    private generation = 0;
    private occurrence = 0;
    private playIntent = false;
    private ended = false;
    private destroyed = false;
    private seeking = false;
    private seekGeneration = 0;
    private preparing = false;
    private pendingTimeline: Promise<ContinuousTimeline | null> | null = null;
    private settleTimeline:
        | ((timeline: ContinuousTimeline | null) => void)
        | null = null;
    private resetting = false;
    private repeatCurrent = false;
    private continuousEnabled = true;
    private repeatSourceId: string | null = null;
    private seekTarget: number | null = null;
    private lastSource: AudioEngineSource | null = null;
    private lastOptions: AudioEngineLoadOptions = {};
    private readonly listeners = new Map<
        AudioEngineEventType,
        Set<(payload: unknown) => void>
    >();
    private readonly forwarders = new Map<
        AudioEngineEventType,
        (payload: unknown) => void
    >();

    constructor(private readonly options: ContinuousAudioEngineOptions) {
        for (const event of events) {
            const forwarder = (payload: unknown) =>
                this.forward(event, payload);
            this.forwarders.set(event, forwarder);
            options.base.on(event, forwarder);
        }
    }

    async load(
        source: AudioEngineSource | string,
        options: AudioEngineLoadOptions = {},
    ): Promise<void> {
        if (this.destroyed) return;
        const value = normalized(source);
        this.lastSource = value;
        this.lastOptions = options;
        this.playIntent = options.autoplay ?? false;
        if (!this.continuousEnabled || !value.url.startsWith("blob:")) {
            this.generation++;
            this.clearTransport();
            this.ended = false;
            this.options.base.load(value, options);
            return;
        }
        const current = this.timeline?.current;
        if (
            current &&
            current.url === value.url &&
            (options.startTimeSec ?? 0) === 0 &&
            this.logical?.id !== current.id
        ) {
            this.adopt(current);
            this.ended = false;
            const generation = this.generation;
            queueMicrotask(() => {
                if (generation !== this.generation || this.destroyed) return;
                this.emit("load", { durationSec: this.getDuration() });
                if (!this.playIntent) this.options.base.pause();
            });
            return;
        }
        const generation = ++this.generation;
        this.clearTransport();
        this.resetting = true;
        try {
            this.options.base.stop();
        } finally {
            this.resetting = false;
        }
        this.ended = false;
        this.preparing = true;
        this.pendingTimeline = new Promise((resolve) => {
            this.settleTimeline = resolve;
        });
        const controller = (this.loadAbort = new AbortController());
        try {
            const prepared = await this.options.prepare(
                value,
                controller.signal,
            );
            if (generation !== this.generation || this.destroyed) return;
            this.preparing = false;
            if (!prepared) {
                this.options.base.load(value, {
                    ...options,
                    autoplay: this.playIntent,
                });
                return;
            }
            const active = { ...prepared, id: String(++this.occurrence) };
            this.adopt({ ...active, startSec: 0 });
            this.timeline = this.options.createTimeline(active, {
                readPosition: () =>
                    this.options.base.getActualCurrentTime?.() ??
                    this.options.base.getCurrentTime(),
                onBoundary: (id) => {
                    if (
                        generation === this.generation &&
                        id === this.logical?.id
                    )
                        this.finish();
                },
                onNextReady: (id) => {
                    if (generation === this.generation && id === this.preloadId)
                        this.preloadController?.settle({ state: "ready" });
                },
                onError: (error) => {
                    if (generation === this.generation) this.fail(error);
                },
            });
            this.stageRepeat();
            this.settleTimeline?.(this.timeline);
            this.options.base.load(
                { url: this.timeline.url },
                {
                    ...options,
                    autoplay: this.playIntent,
                },
            );
        } catch (error) {
            if (!controller.signal.aborted && generation === this.generation)
                this.fail(error);
        } finally {
            if (generation === this.generation) {
                this.preparing = false;
                this.settleTimeline?.(null);
                this.settleTimeline = null;
                this.pendingTimeline = null;
            }
        }
    }

    preload(
        source: AudioEngineSource | string,
        options?: AudioEngineLoadOptions,
    ): AudioPreloadLease | null {
        if (this.destroyed || this.repeatCurrent) return null;
        if (!this.timeline && !this.preparing)
            return this.options.base.preload?.(source, options) ?? null;
        this.preloadController?.lease.cancel();
        const value = normalized(source),
            generation = this.generation;
        const pendingTimeline =
            this.pendingTimeline ?? Promise.resolve(this.timeline);
        let timeline = this.timeline;
        if (!value.url.startsWith("blob:")) {
            return this.options.base.preload?.(source, options) ?? null;
        }
        const abort = (this.preloadAbort = new AbortController()),
            id = String(++this.occurrence);
        const controller = createAudioPreloadLease(value.url, () => {
            abort.abort();
            timeline?.cancel(id);
            if (this.preloadId === id) {
                this.preloadId = null;
                this.preloadController = null;
            }
        });
        this.preloadController = controller;
        this.preloadId = id;
        void Promise.all([
            this.options.prepare(value, abort.signal),
            pendingTimeline,
        ])
            .then(([prepared, readyTimeline]) => {
                if (abort.signal.aborted || generation !== this.generation)
                    return;
                if (!prepared || !readyTimeline) {
                    controller.settle({
                        state: "failed",
                        code: "continuous_format_unsupported",
                    });
                    return;
                }
                timeline = readyTimeline;
                timeline.stage({ ...prepared, id });
                return timeline.pump();
            })
            .catch(() => {
                if (!abort.signal.aborted) {
                    controller.settle({
                        state: "failed",
                        code: "continuous_preload_failed",
                    });
                    timeline?.cancel(id);
                }
            });
        return controller.lease;
    }

    play(): void | Promise<void> {
        this.playIntent = true;
        if (this.preparing || this.seeking || this.destroyed) return;
        return this.options.base.play();
    }
    pause(): void | Promise<void> {
        this.playIntent = false;
        return this.options.base.pause();
    }
    stop(): void | Promise<void> {
        this.playIntent = false;
        this.generation++;
        this.clearTransport();
        return this.options.base.stop();
    }

    async seek(position: number): Promise<void> {
        if (!Number.isFinite(position)) return;
        const repeated = this.timeline?.current;
        if (
            position === 0 &&
            this.repeatCurrent &&
            this.ended &&
            repeated &&
            this.logical &&
            repeated.id !== this.logical.id &&
            repeated.url === this.logical.url
        ) {
            this.adopt(repeated);
            this.ended = false;
            this.repeatSourceId = null;
            this.stageRepeat();
            this.emit("seek", { timeSec: this.getCurrentTime() });
            return;
        }
        if (!this.timeline || !this.logical) {
            await this.options.base.seek(position);
            return;
        }
        const generation = this.generation,
            timeline = this.timeline;
        const seekGeneration = ++this.seekGeneration;
        this.seeking = true;
        const target = Math.max(0, Math.min(position, this.getDuration()));
        this.seekTarget = target;
        try {
            await timeline.seek(target);
            if (
                generation !== this.generation ||
                seekGeneration !== this.seekGeneration
            )
                return;
            this.logical.startSec = timeline.current.startSec;
            this.ended = false;
            await this.options.base.seek(this.logical.startSec + target);
            if (
                generation === this.generation &&
                seekGeneration === this.seekGeneration &&
                this.playIntent &&
                !this.options.base.isPlaying()
            ) {
                await this.options.base.play();
            }
        } catch (error) {
            if (generation === this.generation) this.fail(error);
        } finally {
            if (
                generation === this.generation &&
                seekGeneration === this.seekGeneration
            ) {
                this.seeking = false;
                this.seekTarget = null;
            }
        }
    }

    setVolume(value: number): void {
        this.options.base.setVolume(value);
    }
    setMuted(value: boolean): void {
        this.options.base.setMuted(value);
    }
    /** External group authority must own every transition, including repeat. */
    setContinuousEnabled(enabled: boolean): void {
        if (this.continuousEnabled === enabled) return;
        this.continuousEnabled = enabled;
        if (!enabled && (this.timeline || this.preparing) && this.lastSource) {
            const position = this.getCurrentTime();
            void this.load(this.lastSource, {
                ...this.lastOptions,
                startTimeSec: position,
                autoplay: this.playIntent,
            });
        }
    }
    /** Prepares another occurrence of this recording without an ended/pause gap. */
    setRepeatCurrent(enabled: boolean): void {
        if (this.repeatCurrent === enabled) return;
        this.repeatCurrent = enabled;
        if (enabled) {
            this.preloadController?.lease.cancel();
            this.stageRepeat();
        } else if (this.repeatSourceId) {
            this.timeline?.cancel(this.repeatSourceId);
            this.repeatSourceId = null;
        }
    }
    getCurrentTime(): number {
        return this.relative(this.options.base.getCurrentTime());
    }
    getActualCurrentTime(): number {
        return this.relative(
            this.options.base.getActualCurrentTime?.() ??
                this.options.base.getCurrentTime(),
        );
    }
    getDuration(): number {
        return this.logical?.durationSec ?? this.options.base.getDuration();
    }
    isPlaying(): boolean {
        return this.options.base.isPlaying();
    }
    getBufferedAheadSec(): number | null {
        return this.options.base.getBufferedAheadSec?.() ?? null;
    }
    getDiagnosticState() {
        return (
            this.options.base.getDiagnosticState?.() ?? {
                nativePaused: null,
                readyState: null,
                networkState: null,
                mediaErrorCode: null,
                audioContextState: "unknown" as const,
            }
        );
    }
    hasTrackEnded(): boolean {
        return this.logical
            ? this.ended
            : (this.options.base.hasTrackEnded?.() ?? false);
    }
    isCurrentlySeeking(): boolean {
        return (
            this.seeking || Boolean(this.options.base.isCurrentlySeeking?.())
        );
    }
    getSeekTarget(): number | null {
        return this.logical
            ? this.seekTarget
            : (this.options.base.getSeekTarget?.() ?? null);
    }
    notifyTrackEnded(): void {
        if (this.logical) this.finish();
        else this.options.base.notifyTrackEnded?.();
    }
    reload(): void {
        if (!this.logical && this.options.base.reload) {
            void this.options.base.reload();
            return;
        }
        if (this.lastSource)
            void this.load(this.lastSource, {
                ...this.lastOptions,
                startTimeSec: this.getCurrentTime(),
                autoplay: this.playIntent,
            });
    }
    on<T extends AudioEngineEventType>(
        event: T,
        handler: AudioEngineEventHandler<T>,
    ): void {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(handler as (payload: unknown) => void);
    }
    off<T extends AudioEngineEventType>(
        event: T,
        handler: AudioEngineEventHandler<T>,
    ): void {
        this.listeners
            .get(event)
            ?.delete(handler as (payload: unknown) => void);
    }
    destroy(): void {
        this.destroyed = true;
        this.stop();
        for (const [event, handler] of this.forwarders)
            this.options.base.off(event, handler);
        this.options.base.destroy?.();
        this.listeners.clear();
    }

    private adopt(source: ContinuousAudioSource & { startSec: number }): void {
        this.logical = {
            id: source.id,
            url: source.url,
            mime: source.mime,
            durationSec: source.durationSec,
            startSec: source.startSec,
        };
    }
    private relative(position: number): number {
        return this.logical
            ? Math.min(
                  this.logical.durationSec,
                  Math.max(0, position - this.logical.startSec),
              )
            : position;
    }
    private clearTransport(): void {
        this.settleTimeline?.(null);
        this.settleTimeline = null;
        this.pendingTimeline = null;
        this.seekGeneration++;
        this.preparing = false;
        this.loadAbort?.abort();
        this.preloadController?.lease.cancel();
        this.preloadAbort?.abort();
        this.timeline?.dispose();
        this.timeline = null;
        this.logical = null;
        this.seeking = false;
        this.seekTarget = null;
        this.repeatSourceId = null;
    }
    private stageRepeat(): void {
        if (!this.repeatCurrent || !this.timeline || this.repeatSourceId)
            return;
        const id = String(++this.occurrence),
            generation = this.generation;
        this.repeatSourceId = id;
        this.timeline.stage({ ...this.timeline.current, id });
        void this.timeline.pump().catch((error) => {
            if (generation === this.generation) this.fail(error);
        });
    }
    private finish(): void {
        if (this.ended || this.destroyed) return;
        this.ended = true;
        this.emit("end", undefined);
    }
    private fail(error: unknown): void {
        this.emit("error", {
            error,
            code: "continuous_audio_failed",
            recoverable: true,
        });
    }
    private emit<T extends AudioEngineEventType>(
        event: T,
        payload: AudioEngineEventPayloadMap[T],
    ): void {
        this.listeners.get(event)?.forEach((fn) => fn(payload));
    }
    private forward(event: AudioEngineEventType, payload: unknown): void {
        if (this.destroyed) return;
        if (this.resetting && (event === "pause" || event === "stop")) return;
        if (this.timeline) {
            if (event === "timeupdate" || event === "buffering") {
                const generation = this.generation;
                void this.timeline.pump().catch((error) => {
                    if (generation === this.generation) this.fail(error);
                });
            }
            if (event === "load") {
                this.emit("load", { durationSec: this.getDuration() });
                return;
            }
            if (event === "timeupdate" || event === "seek") {
                this.emit(event, { timeSec: this.getCurrentTime() });
                return;
            }
            if (event === "end") {
                this.finish();
                return;
            }
        }
        this.listeners.get(event)?.forEach((fn) => fn(payload));
    }
}
