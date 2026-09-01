import { logger } from "../utils/logger";

function cancellationError(label: string): Error {
    const error = new Error(`${label} cancelled`);
    error.name = "AbortError";
    return error;
}

async function abortableDelay(
    delayMs: number,
    label: string,
    signal?: AbortSignal,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(cancellationError(label));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, delayMs);
        if (signal) {
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
        }
    });
}

/** Retry transient sidecar failures with exponential backoff and cancellation. */
export async function retryYtMusicRequest<T>(
    operation: () => Promise<T>,
    label: string,
    maxRetries = 3,
    baseDelayMs = 1000,
    signal?: AbortSignal,
): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal?.aborted) throw cancellationError(label);
        try {
            return await operation();
        } catch (requestError: any) {
            const status = requestError?.response?.status;
            const isRetryable =
                status === 429 ||
                (status >= 500 && status < 600) ||
                requestError?.code === "ECONNRESET" ||
                requestError?.code === "ETIMEDOUT";
            if (!isRetryable || attempt === maxRetries) throw requestError;

            const retryAfter = requestError?.response?.headers?.["retry-after"];
            let delayMs = retryAfter
                ? parseInt(retryAfter, 10) * 1000 || baseDelayMs
                : baseDelayMs * Math.pow(2, attempt);
            if (!retryAfter) {
                delayMs += delayMs * (Math.random() * 0.5 - 0.25);
            }
            logger.warn(
                `[YTMusic] ${label} failed (status=${status}, attempt=${attempt + 1}/${maxRetries}), ` +
                    `retrying in ${Math.round(delayMs)}ms`,
            );
            await abortableDelay(delayMs, label, signal);
        }
    }
    throw new Error(`[YTMusic] ${label}: exhausted retries`);
}
