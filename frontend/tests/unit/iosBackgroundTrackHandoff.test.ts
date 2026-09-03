import assert from "node:assert/strict";
import test from "node:test";
import {
    createIosBackgroundTrackHandoff,
    IOS_BACKGROUND_HANDOFF_TARGET_REMAINING_SECONDS,
    type IosBackgroundTrackHandoffScheduler,
} from "../../lib/audio-engine/iosBackgroundTrackHandoff";

function createFakeScheduler() {
    let nextId = 1;
    const callbacks = new Map<number, () => void>();
    const delays: number[] = [];
    const scheduler: IosBackgroundTrackHandoffScheduler = {
        setTimer(callback, delayMs) {
            const id = nextId++;
            callbacks.set(id, callback);
            delays.push(delayMs);
            return id;
        },
        clearTimer(id) {
            callbacks.delete(id as number);
        },
    };
    return {
        scheduler,
        delays,
        fire(id = 1) {
            const callback = callbacks.get(id);
            callbacks.delete(id);
            callback?.();
        },
        pendingCount: () => callbacks.size,
    };
}

const eligibleInput = {
    occurrenceId: "queue-4:track-1",
    activeEngine: "native" as const,
    isIosStandalonePwa: true,
    isDocumentHidden: true,
    isPlaying: true,
    isLoading: false,
    isListenTogether: false,
    repeatMode: "off" as const,
    hasNextTrack: true,
    nextTrackPreloadRequested: true,
    currentTimeSec: 176,
    durationSec: 180,
};

test("arms one pre-end handoff while an installed iOS PWA plays in background", () => {
    const fake = createFakeScheduler();
    const handoff = createIosBackgroundTrackHandoff(fake.scheduler);
    let calls = 0;

    handoff.observe(eligibleInput, () => {
        calls += 1;
    });
    handoff.observe(
        { ...eligibleInput, currentTimeSec: 177 },
        () => (calls += 1),
    );

    assert.equal(fake.pendingCount(), 1);
    assert.equal(fake.delays.length, 1);
    assert.equal(
        fake.delays[0],
        (4 - IOS_BACKGROUND_HANDOFF_TARGET_REMAINING_SECONDS) * 1000,
    );
    fake.fire();
    assert.equal(calls, 1);
    handoff.observe(
        { ...eligibleInput, currentTimeSec: 179.9 },
        () => (calls += 1),
    );
    assert.equal(calls, 1, "one occurrence must never advance twice");
});

test("does not arm outside the exact iOS standalone background case", () => {
    for (const override of [
        { activeEngine: "howler" as const },
        { isIosStandalonePwa: false },
        { isDocumentHidden: false },
        { isPlaying: false },
        { isLoading: true },
        { isListenTogether: true },
        { repeatMode: "one" as const },
        { hasNextTrack: false },
        { nextTrackPreloadRequested: false },
    ]) {
        const fake = createFakeScheduler();
        const handoff = createIosBackgroundTrackHandoff(fake.scheduler);
        handoff.observe({ ...eligibleInput, ...override }, () => {
            assert.fail("ineligible playback advanced");
        });
        assert.equal(fake.pendingCount(), 0);
    }
});

test("changing playback occurrence cancels a stale timer", () => {
    const fake = createFakeScheduler();
    const handoff = createIosBackgroundTrackHandoff(fake.scheduler);
    let calls = 0;
    handoff.observe(eligibleInput, () => (calls += 1));
    handoff.observe(
        {
            ...eligibleInput,
            occurrenceId: "queue-5:track-2",
            currentTimeSec: 10,
        },
        () => (calls += 1),
    );
    assert.equal(fake.pendingCount(), 0);
    fake.fire();
    assert.equal(calls, 0);
});

test("reset cancels a stale timer and allows the occurrence to arm again", () => {
    const fake = createFakeScheduler();
    const handoff = createIosBackgroundTrackHandoff(fake.scheduler);
    let calls = 0;
    handoff.observe(eligibleInput, () => (calls += 1));
    handoff.reset();
    fake.fire();
    assert.equal(calls, 0);

    handoff.observe(eligibleInput, () => (calls += 1));
    fake.fire(2);
    assert.equal(calls, 1);
});

test("a last timeupdate can hand off immediately before WebKit suspends", () => {
    const fake = createFakeScheduler();
    const handoff = createIosBackgroundTrackHandoff(fake.scheduler);
    let calls = 0;
    handoff.observe(
        { ...eligibleInput, currentTimeSec: 179.8 },
        () => (calls += 1),
    );
    assert.equal(calls, 1);
    assert.equal(fake.pendingCount(), 0);
});
