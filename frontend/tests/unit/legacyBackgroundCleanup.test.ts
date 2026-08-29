import assert from "node:assert/strict";
import test from "node:test";
import { createLegacyBackgroundCleanupLoop } from "../../features/device-offline/legacyBackgroundCleanup";

async function flushPromises(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test("legacy cleanup retries unknown browser state with bounded backoff until cleared", async () => {
    const outcomes = ["unknown", "unknown", "cleared"] as const;
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    let sweeps = 0;
    const loop = createLegacyBackgroundCleanupLoop({
        sweep: async () => outcomes[sweeps++] ?? "cleared",
        schedule: (callback, delayMs) => {
            scheduled.push({ callback, delayMs });
            return scheduled.length;
        },
        cancel: () => undefined,
        backoffMs: [2, 7, 20],
    });

    loop.trigger();
    await flushPromises();
    assert.equal(sweeps, 1);
    assert.equal(scheduled[0]?.delayMs, 2);

    scheduled.shift()?.callback();
    await flushPromises();
    assert.equal(sweeps, 2);
    assert.equal(scheduled[0]?.delayMs, 7);

    scheduled.shift()?.callback();
    await flushPromises();
    assert.equal(sweeps, 3);
    assert.equal(scheduled.length, 0);
    loop.stop();
});

test("legacy cleanup stops after the configured retry budget", async () => {
    const scheduled: Array<() => void> = [];
    let sweeps = 0;
    const loop = createLegacyBackgroundCleanupLoop({
        sweep: async () => {
            sweeps += 1;
            return "unknown";
        },
        schedule: (callback) => {
            scheduled.push(callback);
            return scheduled.length;
        },
        cancel: () => undefined,
        backoffMs: [1, 2],
    });

    loop.trigger();
    await flushPromises();
    scheduled.shift()?.();
    await flushPromises();
    scheduled.shift()?.();
    await flushPromises();

    assert.equal(sweeps, 3);
    assert.equal(scheduled.length, 0);
    loop.stop();
});

test("a fresh trigger cancels a pending retry and restarts the bounded sequence", async () => {
    const scheduled: Array<{
        handle: symbol;
        callback: () => void;
        delayMs: number;
    }> = [];
    const cancelled: unknown[] = [];
    let sweeps = 0;
    const loop = createLegacyBackgroundCleanupLoop({
        sweep: async () => {
            sweeps += 1;
            return sweeps === 1 ? "unknown" : "cleared";
        },
        schedule: (callback, delayMs) => {
            const handle = Symbol("retry");
            scheduled.push({ handle, callback, delayMs });
            return handle;
        },
        cancel: (handle) => cancelled.push(handle),
        backoffMs: [5],
    });

    loop.trigger();
    await flushPromises();
    const first = scheduled[0];
    assert.ok(first);

    loop.trigger();
    await flushPromises();
    assert.deepEqual(cancelled, [first.handle]);
    assert.equal(sweeps, 2);
    loop.stop();
});
