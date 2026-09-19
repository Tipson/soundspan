import type {
    AudioEngine,
    AudioEngineLoadPayload,
} from "../audio-engine/types";

interface Input {
    engine: Pick<AudioEngine, "load" | "on" | "off" | "seek" | "play">;
    url: string;
    trackId: string;
    positionSec: number;
    getPositionSec?(): number;
    durationSec: number;
    signal: AbortSignal;
    isCurrent(): boolean;
    onReady(positionSec: number): void;
}

/** Load a fresh representation paused, validate its duration and restore time before play. */
export function loadRecoveredMusicSource(input: Input): Promise<void> {
    const { engine, signal } = input;
    return new Promise((resolve, reject) => {
        let settled = false;
        let loadingHandled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", aborted);
            engine.off("load", loaded);
            engine.off("loaderror", failed);
            engine.off("playerror", failed);
            error ? reject(error) : resolve();
        };
        const aborted = () =>
            finish(new DOMException("Recovery interrupted", "AbortError"));
        const failed = () => finish(new Error("Replacement audio failed"));
        const assertCurrent = () => {
            if (settled || signal.aborted || !input.isCurrent())
                throw new DOMException("Playback changed", "AbortError");
        };
        const resume = async (duration: number) => {
            assertCurrent();
            if (
                !Number.isFinite(duration) ||
                Math.abs(duration - input.durationSec) >
                    Math.min(5, Math.max(2, input.durationSec * 0.015))
            ) {
                throw new Error("Replacement duration mismatch");
            }
            const position = () =>
                input.getPositionSec?.() ?? input.positionSec;
            let target: number;
            do {
                target = position();
                if (
                    !Number.isFinite(target) ||
                    target < 0 ||
                    target >= duration
                )
                    throw new Error("Invalid replacement position");
                await engine.seek(target);
                assertCurrent();
            } while (target !== position());
            input.onReady(target);
            assertCurrent();
            await engine.play();
        };
        const loaded = (payload: AudioEngineLoadPayload) => {
            if (loadingHandled || settled) return;
            loadingHandled = true;
            void resume(payload.durationSec).then(() => finish(), failed);
        };
        if (signal.aborted || !input.isCurrent()) {
            aborted();
            return;
        }
        signal.addEventListener("abort", aborted, { once: true });
        engine.on("load", loaded);
        engine.on("loaderror", failed);
        engine.on("playerror", failed);
        try {
            const loading = engine.load(
                {
                    url: input.url,
                    trackId: input.trackId,
                    sourceType: "unknown",
                },
                // Direct source adapters supply MP3; opaque lease URLs have no
                // extension for Howler's codec detection.
                { autoplay: false, format: "mp3" },
            );
            if (loading) void loading.catch(failed);
        } catch {
            failed();
        }
    });
}
