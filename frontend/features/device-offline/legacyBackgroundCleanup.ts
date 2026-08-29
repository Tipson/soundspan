import {
    sweepLegacyBrowserBackgroundFetches,
    type DeviceOfflineBackgroundFetchAbortResult,
} from "./platform";

const DEFAULT_BACKOFF_MS = [1_000, 5_000, 15_000, 30_000] as const;

export interface LegacyBackgroundCleanupLoop {
    trigger(): void;
    stop(): void;
}

interface LegacyBackgroundCleanupLoopOptions {
    sweep?: () => Promise<DeviceOfflineBackgroundFetchAbortResult>;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancel?: (handle: unknown) => void;
    backoffMs?: readonly number[];
}

/**
 * Repeatedly clears legacy Chromium Background Fetch registrations. Unknown
 * browser state is retried with bounded backoff; focus/controller changes can
 * trigger a fresh bounded sequence without creating overlapping sweeps.
 */
export function createLegacyBackgroundCleanupLoop(
    options: LegacyBackgroundCleanupLoopOptions = {},
): LegacyBackgroundCleanupLoop {
    const sweep = options.sweep ?? sweepLegacyBrowserBackgroundFetches;
    const schedule =
        options.schedule ??
        ((callback: () => void, delayMs: number) =>
            window.setTimeout(callback, delayMs));
    const cancel =
        options.cancel ??
        ((handle: unknown) => window.clearTimeout(handle as number));
    const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;

    let stopped = false;
    let running = false;
    let requestedWhileRunning = false;
    let attempt = 0;
    let timer: unknown | null = null;

    const clearTimer = () => {
        if (timer === null) return;
        cancel(timer);
        timer = null;
    };

    const run = () => {
        if (stopped) return;
        if (running) {
            requestedWhileRunning = true;
            return;
        }
        running = true;
        void sweep()
            .catch(() => "unknown" as const)
            .then((result) => {
                if (stopped) return;
                if (result === "cleared") {
                    attempt = 0;
                    return;
                }
                if (attempt >= backoffMs.length) return;
                const delayMs = Math.max(0, backoffMs[attempt++] ?? 0);
                timer = schedule(() => {
                    timer = null;
                    run();
                }, delayMs);
            })
            .finally(() => {
                running = false;
                if (!requestedWhileRunning || stopped) return;
                requestedWhileRunning = false;
                clearTimer();
                run();
            });
    };

    return {
        trigger() {
            if (stopped) return;
            attempt = 0;
            clearTimer();
            run();
        },
        stop() {
            stopped = true;
            requestedWhileRunning = false;
            clearTimer();
        },
    };
}
