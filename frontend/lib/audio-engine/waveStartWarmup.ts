import type { TailWarmupReconciler } from "./adaptiveQueueWarmup";

/** One low-priority startup interest; never starts browser playback. */
export function beginWaveStartWarmup(
    reconcile: TailWarmupReconciler,
    ownerId: string,
    videoId: string,
): { handoff(): void; dispose(): void } {
    const controller = new AbortController();
    let retained = false;
    let disposed = false;
    const base = { ownerId, current: null, immediate: null };
    // Best effort, no retries: saturation must never delay foreground play.
    void reconcile(
        { ...base, generation: 1, tail: [videoId] },
        controller.signal,
    ).catch(() => undefined);
    return {
        handoff() {
            retained = true;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            // The existing server TTL bounds a retained interest. Cancelling
            // here could kill the shared spool before foreground joins it.
            if (retained) return;
            controller.abort();
            void reconcile(
                { ...base, generation: 2, tail: [] },
                new AbortController().signal,
            ).catch(() => undefined);
        },
    };
}
