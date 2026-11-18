/** Remaining server holdoff from the exact query's current API error receipt. */
export function remainingSearchRetryMs(
    error: unknown,
    now = performance.now(),
): number {
    if (!error || typeof error !== "object" || !("status" in error)) return 0;
    if (error.status !== 429 && error.status !== 503) return 0;
    if (!("responseReceipt" in error)) return 0;
    const receipt = error.responseReceipt;
    if (!receipt || typeof receipt !== "object") return 0;
    if (!("status" in receipt) || receipt.status !== error.status) return 0;
    if (!("retryAfterMs" in receipt) || !("receivedMonotonicMs" in receipt))
        return 0;
    const delay = receipt.retryAfterMs;
    const received = receipt.receivedMonotonicMs;
    if (
        typeof delay !== "number" ||
        !Number.isFinite(delay) ||
        delay < 0 ||
        delay > 24 * 60 * 60 * 1000 ||
        typeof received !== "number" ||
        !Number.isFinite(received) ||
        received < 0 ||
        !Number.isFinite(now)
    )
        return 0;
    return Math.max(0, delay - Math.max(0, now - received));
}

/** Search keeps the existing backoff while honoring a bounded Retry-After. */
export function searchRetryDelay(attempt: number, error: unknown): number {
    return Math.max(
        Math.min(1000 * 2 ** attempt, 30_000),
        remainingSearchRetryMs(error),
    );
}
