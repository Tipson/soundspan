import type { AudioEngine } from "./types";

interface PlaybackDiagnosticObserverOptions {
    engine: Pick<AudioEngine, "on" | "off" | "getDuration">;
    page: Pick<EventTarget, "addEventListener" | "removeEventListener">;
    document: Pick<
        Document,
        "addEventListener" | "removeEventListener" | "visibilityState"
    >;
    record(event: string): void;
    wake(): void;
}

/** Event-driven diagnostics only: no media controls or progress polling. */
export function observePlaybackDiagnostics(
    options: PlaybackDiagnosticObserverOptions,
): () => void {
    const safely = (callback: () => void) => () => {
        try {
            callback();
        } catch {
            /* Diagnostics cannot interrupt playback. */
        }
    };
    const wake = safely(options.wake);
    const pause = safely(() => options.record("player.engine_pause"));
    const end = safely(() => options.record("player.track_end"));
    const visibility = safely(() => {
        if (options.engine.getDuration() > 0)
            options.record("player.visibility_change");
        if (options.document.visibilityState === "visible") wake();
    });
    options.engine.on("pause", pause);
    options.engine.on("end", end);
    options.page.addEventListener("online", wake);
    options.page.addEventListener("pageshow", wake);
    options.document.addEventListener("visibilitychange", visibility);
    wake();
    return () => {
        options.engine.off("pause", pause);
        options.engine.off("end", end);
        options.page.removeEventListener("online", wake);
        options.page.removeEventListener("pageshow", wake);
        options.document.removeEventListener("visibilitychange", visibility);
    };
}
