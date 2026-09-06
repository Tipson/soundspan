import assert from "node:assert/strict";
import test from "node:test";
import { beginWaveStartWarmup } from "../../lib/audio-engine/waveStartWarmup";
import type { TailWarmupReconcileRequest } from "../../lib/audio-engine/adaptiveQueueWarmup";

test("warm one tail item and cancel with a newer generation on departure", () => {
    const calls: TailWarmupReconcileRequest[] = [];
    const signals: AbortSignal[] = [];
    const warm = beginWaveStartWarmup(
        async (request, signal) => {
            calls.push(request);
            signals.push(signal);
        },
        "wave-owner",
        "dQw4w9WgXcQ",
    );
    assert.deepEqual(calls[0], {
        ownerId: "wave-owner",
        generation: 1,
        current: null,
        immediate: null,
        tail: ["dQw4w9WgXcQ"],
    });
    warm.dispose();
    warm.dispose();
    assert.equal(calls.length, 2);
    assert.equal(signals[0].aborted, true);
    assert.equal(calls[1].generation, 2);
    assert.deepEqual(calls[1].tail, []);
});

test("Play retains the bounded server job for foreground single-flight handoff", () => {
    const calls: TailWarmupReconcileRequest[] = [];
    const warm = beginWaveStartWarmup(
        async (request) => {
            calls.push(request);
        },
        "wave-owner",
        "dQw4w9WgXcQ",
    );
    warm.handoff();
    warm.dispose();
    assert.equal(calls.length, 1);
});

test("warmup failure neither retries nor escapes as an unhandled rejection", async () => {
    let calls = 0;
    const warm = beginWaveStartWarmup(
        async () => {
            calls++;
            throw new Error("busy");
        },
        "wave-owner",
        "dQw4w9WgXcQ",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    warm.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
});
