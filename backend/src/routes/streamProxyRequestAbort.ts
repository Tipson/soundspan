import type { Request, Response } from "express";

/** Lifetime of a cold provider request before its upstream stream is acquired. */
export interface StreamProxyRequestAbort {
    signal: AbortSignal;
    wasClientAborted(): boolean;
    dispose(): void;
}

/**
 * Propagates browser navigation/track-switch cancellation to a provider.
 * A normal response close after all bytes were written is deliberately ignored.
 */
export function createStreamProxyRequestAbort(
    req: Request,
    res: Response,
): StreamProxyRequestAbort {
    const controller = new AbortController();
    let clientAborted = false;

    const abortPendingProvider = (): void => {
        if (controller.signal.aborted) return;
        clientAborted = true;
        controller.abort();
    };
    const handleResponseClose = (): void => {
        if (!res.writableEnded) abortPendingProvider();
    };

    if (typeof req.once === "function") {
        req.once("aborted", abortPendingProvider);
    }
    if (typeof res.once === "function") {
        res.once("close", handleResponseClose);
    }
    // Settings/auth lookups can finish after the browser has already left.
    if (req.aborted || (res.destroyed && !res.writableEnded)) {
        abortPendingProvider();
    }

    return {
        signal: controller.signal,
        wasClientAborted: () => clientAborted || req.aborted,
        dispose: () => {
            if (typeof req.off === "function") {
                req.off("aborted", abortPendingProvider);
            }
            if (typeof res.off === "function") {
                res.off("close", handleResponseClose);
            }
        },
    };
}

/** Acquires a provider stream while treating a superseded browser request as cancellation. */
export async function acquireAbortableStreamProxy<T>(
    req: Request,
    res: Response,
    acquire: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
    const requestAbort = createStreamProxyRequestAbort(req, res);
    try {
        if (requestAbort.wasClientAborted()) return null;
        const proxy = await acquire(requestAbort.signal);
        return requestAbort.wasClientAborted() ? null : proxy;
    } catch (error) {
        if (requestAbort.wasClientAborted()) return null;
        throw error;
    } finally {
        requestAbort.dispose();
    }
}
