import { useEffect, useRef } from "react";

/** A playback URL whose lifetime is explicitly owned by its caller. */
export interface PlaybackSourceLease {
    url: string;
    release(): void;
}

/**
 * Keeps at most one playback-source lease alive and rejects results from an
 * obsolete load generation before they can reach the audio engine.
 */
export interface PlaybackSourceLeaseController {
    acquire(
        acquireSource: (signal: AbortSignal) => Promise<PlaybackSourceLease>,
        isCurrent: () => boolean,
    ): Promise<string | null>;
    release(): void;
}

function makeIdempotent(lease: PlaybackSourceLease): PlaybackSourceLease {
    let released = false;
    return {
        url: lease.url,
        release: () => {
            if (released) return;
            released = true;
            lease.release();
        },
    };
}

/** Create the load-generation coordinator used by playback and preloading. */
export function createPlaybackSourceLeaseController(): PlaybackSourceLeaseController {
    let generation = 0;
    let pending: AbortController | null = null;
    let active: PlaybackSourceLease | null = null;

    const release = (): void => {
        generation += 1;
        pending?.abort();
        pending = null;
        active?.release();
        active = null;
    };

    return {
        async acquire(acquireSource, isCurrent) {
            release();
            const requestGeneration = generation;
            const controller = new AbortController();
            pending = controller;

            try {
                const acquired = makeIdempotent(
                    await acquireSource(controller.signal),
                );
                if (
                    controller.signal.aborted ||
                    generation !== requestGeneration ||
                    !isCurrent()
                ) {
                    acquired.release();
                    return null;
                }

                pending = null;
                active = acquired;
                return acquired.url;
            } catch (error) {
                if (
                    controller.signal.aborted ||
                    generation !== requestGeneration ||
                    (error instanceof DOMException &&
                        error.name === "AbortError")
                ) {
                    return null;
                }
                pending = null;
                throw error;
            }
        },
        release,
    };
}

/** Own a playback-source lease controller for one mounted React caller. */
export function usePlaybackSourceLeaseController(): PlaybackSourceLeaseController {
    const controllerRef = useRef<PlaybackSourceLeaseController | null>(null);
    // eslint-disable-next-line react-hooks/refs -- One controller must survive rerenders so its generation can reject stale acquisitions.
    if (!controllerRef.current) {
        controllerRef.current = createPlaybackSourceLeaseController();
    }
    // eslint-disable-next-line react-hooks/refs -- The initialized controller is stable for the mounted caller.
    const controller = controllerRef.current;

    useEffect(() => () => controller.release(), [controller]);

    return controller;
}
