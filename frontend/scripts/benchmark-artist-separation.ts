import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { separateArtists } from "../lib/separate-artists";

// Frozen pre-cleanup algorithm: compare the same input and preserve exact order.
function baseline(items: number[]): number[] {
    const map = new Map<string, number[]>();
    for (const item of items) {
        const key = String(item);
        const bucket = map.get(key) ?? [];
        bucket.push(item);
        map.set(key, bucket);
    }
    const buckets = [...map.values()].sort((a, b) => b.length - a.length);
    const result: number[] = [];
    for (let round = 0; round < buckets[0].length; round++) {
        for (const bucket of buckets) {
            if (round < bucket.length) result.push(bucket[round]);
        }
    }
    return result;
}

const items = Array.from({ length: 10_000 }, (_, i) => (i < 5000 ? 0 : i));
const optimized = () => separateArtists(items, String);
assert.deepEqual(optimized(), baseline(items));
function medianMs(run: () => unknown): number {
    for (let i = 0; i < 5; i++) run();
    const times = Array.from({ length: 15 }, () => {
        const start = performance.now();
        run();
        return performance.now() - start;
    }).sort((a, b) => a - b);
    return times[7];
}
const before = medianMs(() => baseline(items));
const after = medianMs(optimized);
console.log(
    JSON.stringify({
        scenario: "10000 tracks; 5000 from one artist",
        beforeMs: before,
        afterMs: after,
        speedup: before / after,
    }),
);
// Manual performance acceptance, not a wall-clock-sensitive CI unit test.
assert.ok(
    after < before / 2,
    "Skewed queues should avoid rescanning exhausted artist buckets",
);
