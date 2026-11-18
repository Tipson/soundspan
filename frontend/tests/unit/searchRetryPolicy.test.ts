import assert from "node:assert/strict";
import test from "node:test";
import {
    remainingSearchRetryMs,
    searchRetryDelay,
} from "../../features/search/searchRetryPolicy";

const failure = (
    status = 429,
    delay: unknown = 2000,
    received: unknown = 1000,
) => ({
    status,
    responseReceipt: {
        status,
        retryAfterMs: delay,
        receivedMonotonicMs: received,
    },
});

test("search holdoff uses monotonic receipt time, expires, and preserves default backoff", () => {
    assert.equal(remainingSearchRetryMs(failure(), 1100), 1900);
    assert.equal(remainingSearchRetryMs(failure(503), 2500), 500);
    assert.equal(remainingSearchRetryMs(failure(), 3000), 0);
    assert.equal(remainingSearchRetryMs(failure(), 3500), 0);
    assert.equal(remainingSearchRetryMs(failure(), 999), 2000);
    assert.equal(searchRetryDelay(0, null), 1000);
    assert.equal(searchRetryDelay(1, null), 2000);
    assert.equal(searchRetryDelay(10, null), 30000);
    assert.ok(
        searchRetryDelay(0, failure(429, 86400000, performance.now())) >
            86399000,
    );
});

test("only matching bounded API receipts establish a search holdoff", () => {
    for (const value of [
        null,
        {},
        { retryAfterMs: 999999 },
        failure(401),
        failure(504),
        failure(429, null),
        failure(429, -1),
        failure(429, Infinity),
        failure(429, "2000"),
        failure(429, 86400001),
        failure(429, 2000, NaN),
        failure(429, 2000, -1),
        { status: 429, responseReceipt: { ...failure(503).responseReceipt } },
    ]) {
        assert.equal(remainingSearchRetryMs(value, 1100), 0);
    }
});
