/** Leaves four seconds for the existing seventeen-second client transport budget. */
export const RADIO_REQUEST_TIMEOUT_MS = 13_000;

/** Static request-local interruption; upstream errors and caller reasons are never exposed. */
export class RadioRequestError extends Error {
    constructor(
        readonly code: "RADIO_REQUEST_TIMEOUT" | "RADIO_REQUEST_CANCELLED",
    ) {
        super(
            code === "RADIO_REQUEST_TIMEOUT"
                ? "Radio request timed out"
                : "Radio request cancelled",
        );
        this.name = "RadioRequestError";
    }
}

/** Bounds one owner request without cancelling shared provider/cache operations. */
export interface RadioRequestExecution {
    check(): void;
    remainingMs(): number;
    run<T>(operation: () => Promise<T>): Promise<T>;
    dispose(): void;
}

/** Creates one monotonic deadline and one cancellation listener for all request phases. */
export function createRadioRequestExecution(
    signal?: AbortSignal,
): RadioRequestExecution {
    const deadline = performance.now() + RADIO_REQUEST_TIMEOUT_MS;
    let error: RadioRequestError | undefined;
    let disposed = false;
    let rejectStopped!: (error: RadioRequestError) => void;
    const stopped = new Promise<never>((_, reject) => {
        rejectStopped = reject;
    });
    // The scope can be cancelled before its first awaited operation.
    void stopped.catch(() => {});
    const stop = (code: RadioRequestError["code"]) => {
        if (error) return;
        error = new RadioRequestError(code);
        rejectStopped(error);
    };
    const cancelled = () => stop("RADIO_REQUEST_CANCELLED");
    const timer = setTimeout(
        () => stop("RADIO_REQUEST_TIMEOUT"),
        RADIO_REQUEST_TIMEOUT_MS,
    );
    timer.unref?.();
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
    const check = () => {
        if (!error && performance.now() >= deadline)
            stop("RADIO_REQUEST_TIMEOUT");
        if (error) throw error;
    };
    return {
        check,
        remainingMs: () => {
            check();
            return Math.max(1, Math.floor(deadline - performance.now()));
        },
        async run(operation) {
            check();
            const work = Promise.resolve()
                .then(() => {
                    check();
                    return operation();
                })
                .then(
                    (value) => {
                        check();
                        return value;
                    },
                    (failure: unknown) => {
                        check();
                        throw failure;
                    },
                );
            return Promise.race([work, stopped]);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancelled);
        },
    };
}
