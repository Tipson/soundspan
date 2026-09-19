import {
    ContinuousAudioBuffer,
    type ContinuousAudioSource,
} from "./continuousAudioBuffer";
import type {
    ContinuousAudioEngineOptions,
    ContinuousTimeline,
} from "./continuousAudioEngine";

/** Binds the bounded transport to one MediaSource URL and its native events. */
export const createContinuousAudioTimeline: ContinuousAudioEngineOptions["createTimeline"] =
    (initial, callbacks): ContinuousTimeline => {
        const media = new MediaSource();
        const url = URL.createObjectURL(media);
        let core: ContinuousAudioBuffer | null = null;
        let initialOwned: ContinuousAudioSource | null = initial;
        let buffer: SourceBuffer | null = null;
        let next: ContinuousAudioSource | null = null;
        let disposed = false;
        let seekGeneration = 0;
        let seeking = false;
        let resolveReady!: () => void;
        let rejectReady!: (error: unknown) => void;
        const ready = new Promise<void>((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });
        // Initialization may fail before an explicit seek starts awaiting readiness.
        void ready.catch(() => undefined);
        const pump = async () => {
            if (disposed || !core || seeking) return;
            const active = core;
            active.checkBoundary();
            if (disposed) return;
            await active.pump();
            if (
                !disposed &&
                active.exhausted &&
                media.readyState === "open" &&
                !buffer?.updating
            ) {
                // A later append reopens an ended MediaSource without changing src.
                // Closing only after every supplied byte flushes the last decoder frame.
                media.endOfStream();
            }
        };
        const opened = () => {
            if (disposed) return;
            try {
                if (!initialOwned) return;
                buffer = media.addSourceBuffer(initialOwned.mime);
                core = new ContinuousAudioBuffer({
                    buffer,
                    current: initialOwned,
                    readPosition: callbacks.readPosition,
                    onBoundary: callbacks.onBoundary,
                    onNextReady: callbacks.onNextReady,
                });
                initialOwned = null;
                if (next) {
                    core.stageNext(next);
                    next = null;
                }
                void pump().then(resolveReady, (error) => {
                    rejectReady(error);
                    callbacks.onError(error);
                });
            } catch (error) {
                rejectReady(error);
                callbacks.onError(error);
            }
        };
        media.addEventListener("sourceopen", opened, { once: true });
        return {
            url,
            get current() {
                if (core) return core.current;
                if (initialOwned)
                    return { ...initialOwned, startSec: 0, endSec: null };
                throw new Error("Audio timeline disposed");
            },
            pump,
            stage(source) {
                if (disposed) return;
                if (core) core.stageNext(source);
                else next = source;
            },
            cancel(id) {
                if (next?.id === id) next = null;
                core?.cancelNext(id);
                if (!disposed) void pump().catch(callbacks.onError);
            },
            async seek(position) {
                await ready;
                if (disposed || !core) return;
                const generation = ++seekGeneration;
                seeking = true;
                try {
                    await core.seek(position);
                } finally {
                    if (generation === seekGeneration) seeking = false;
                }
                // The adapter sets native currentTime immediately after this
                // resolves. Pumping with the old position would evict the refill.
            },
            dispose() {
                if (disposed) return;
                disposed = true;
                media.removeEventListener("sourceopen", opened);
                rejectReady(
                    new DOMException("Audio timeline disposed", "AbortError"),
                );
                core?.dispose();
                core = null;
                initialOwned = null;
                next = null;
                URL.revokeObjectURL(url);
            },
        };
    };
