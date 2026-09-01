import assert from "node:assert/strict";
import test from "node:test";
import { resolveAdaptiveWaveSkip } from "../../lib/audio/adaptiveWaveQueue";

test("regenerates a provider Wave after three consecutive early manual skips", () => {
    const first = resolveAdaptiveWaveSkip({
        previousStreak: 0,
        origin: "manual",
        vibeMode: true,
        isProviderTrack: true,
        listenedSeconds: 4,
        durationSeconds: 180,
    });
    const second = resolveAdaptiveWaveSkip({
        previousStreak: first.nextStreak,
        origin: "manual",
        vibeMode: true,
        isProviderTrack: true,
        listenedSeconds: 12,
        durationSeconds: 180,
    });
    const third = resolveAdaptiveWaveSkip({
        previousStreak: second.nextStreak,
        origin: "manual",
        vibeMode: true,
        isProviderTrack: true,
        listenedSeconds: 20,
        durationSeconds: 180,
    });

    assert.deepEqual(first, { nextStreak: 1, shouldRegenerate: false });
    assert.deepEqual(second, { nextStreak: 2, shouldRegenerate: false });
    assert.deepEqual(third, { nextStreak: 0, shouldRegenerate: true });
});

test("meaningful listening resets the skip streak", () => {
    assert.deepEqual(
        resolveAdaptiveWaveSkip({
            previousStreak: 2,
            origin: "manual",
            vibeMode: true,
            isProviderTrack: true,
            listenedSeconds: 50,
            durationSeconds: 180,
        }),
        { nextStreak: 0, shouldRegenerate: false },
    );
});

test("unknown duration uses elapsed seconds instead of treating every skip as early", () => {
    assert.deepEqual(
        resolveAdaptiveWaveSkip({
            previousStreak: 2,
            origin: "manual",
            vibeMode: true,
            isProviderTrack: true,
            listenedSeconds: 45,
            durationSeconds: 0,
        }),
        { nextStreak: 0, shouldRegenerate: false },
    );
});

test("technical failures neither count as skips nor erase the session streak", () => {
    assert.deepEqual(
        resolveAdaptiveWaveSkip({
            previousStreak: 2,
            origin: "error",
            vibeMode: true,
            isProviderTrack: true,
            listenedSeconds: 0,
            durationSeconds: 180,
        }),
        { nextStreak: 2, shouldRegenerate: false },
    );
});

test("leaving provider Wave clears the adaptive streak", () => {
    assert.deepEqual(
        resolveAdaptiveWaveSkip({
            previousStreak: 2,
            origin: "manual",
            vibeMode: false,
            isProviderTrack: true,
            listenedSeconds: 1,
            durationSeconds: 180,
        }),
        { nextStreak: 0, shouldRegenerate: false },
    );
});
