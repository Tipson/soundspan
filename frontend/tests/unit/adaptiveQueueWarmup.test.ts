import assert from "node:assert/strict";
import test from "node:test";
import {
    AdaptiveQueueWarmupCoordinator,
    resolveAdaptiveTailWarmupCount,
    resolveUpcomingQueueTracks,
    type TailWarmupReconcileRequest,
} from "../../lib/audio-engine/adaptiveQueueWarmup";
import type {
    AudioPreloadLease,
    AudioPreloadResult,
} from "../../lib/audio-engine/types";

const deferredLease = (
    sourceUrl = "next",
): {
    lease: AudioPreloadLease;
    settle: (result: AudioPreloadResult) => void;
} => {
    let settle!: (result: AudioPreloadResult) => void;
    const result = new Promise<AudioPreloadResult>((resolve) => {
        settle = resolve;
    });
    return {
        lease: {
            sourceUrl,
            result,
            cancel: () => settle({ state: "cancelled" }),
        },
        settle,
    };
};

test("adaptive tail policy honors constrained and fast connections", () => {
    assert.equal(
        resolveAdaptiveTailWarmupCount({ saveData: true, effectiveType: "4g" }),
        0,
    );
    assert.equal(
        resolveAdaptiveTailWarmupCount({ effectiveType: "slow-2g" }),
        0,
    );
    assert.equal(resolveAdaptiveTailWarmupCount({ effectiveType: "2g" }), 0);
    assert.equal(resolveAdaptiveTailWarmupCount({ effectiveType: "3g" }), 2);
    assert.equal(resolveAdaptiveTailWarmupCount({ effectiveType: "4g" }), 4);
    assert.equal(resolveAdaptiveTailWarmupCount({}), 2);
    assert.equal(resolveAdaptiveTailWarmupCount({ effectiveType: "wifi" }), 2);
});

test("queue window follows shuffle order, wraps once, and stops at mixed media", () => {
    const queue = [
        { id: "a" },
        { id: "b" },
        { id: "c" },
        { id: "episode", itemType: "episode" },
    ];
    assert.deepEqual(
        resolveUpcomingQueueTracks(queue, 1, true, [2, 1, 0, 3], "all", 4).map(
            (item) => item.id,
        ),
        ["a"],
    );
    assert.deepEqual(
        resolveUpcomingQueueTracks(queue, 0, false, [], "off", 4).map(
            (item) => item.id,
        ),
        ["b", "c"],
    );
    assert.deepEqual(
        resolveUpcomingQueueTracks(queue, 0, false, [], "one", 4),
        [],
    );
});

test("coordinator submits current and immediate before readiness, then adaptive tail", async () => {
    const calls: TailWarmupReconcileRequest[] = [];
    const pending = deferredLease();
    const coordinator = new AdaptiveQueueWarmupCoordinator(
        "player-1",
        async (request) => {
            calls.push(request);
        },
    );

    const completion = coordinator.reconcile({
        quality: "high",
        currentVideoId: "current",
        immediateVideoId: "next",
        tailVideoIds: ["tail-1", "tail-2", "tail-3", "tail-4", "tail-5"],
        connection: { effectiveType: "4g" },
        immediateLease: pending.lease,
    });
    await Promise.resolve();
    assert.deepEqual(
        calls.map((call) => call.tail),
        [[]],
    );

    pending.settle({ state: "ready" });
    await completion;
    assert.deepEqual(
        calls.map((call) => call.tail),
        [[], ["tail-1", "tail-2", "tail-3", "tail-4"]],
    );
    assert.equal(calls[0].generation, calls[1].generation);
});

for (const skips of [10, 20]) {
    test(`rapid-skip ${skips} generations only admits the latest tail`, async () => {
        const calls: Array<{
            request: TailWarmupReconcileRequest;
            aborted: boolean;
        }> = [];
        const leases = Array.from({ length: skips }, (_, index) =>
            deferredLease(`next-${index}`),
        );
        const coordinator = new AdaptiveQueueWarmupCoordinator(
            "rapid-player",
            async (request, signal) => {
                calls.push({ request, aborted: signal.aborted });
            },
        );

        const completions = leases.map(({ lease }, index) =>
            coordinator.reconcile({
                currentVideoId: `current-${index}`,
                immediateVideoId: `next-${index}`,
                tailVideoIds: [`tail-${index}-1`, `tail-${index}-2`],
                connection: { effectiveType: "4g" },
                immediateLease: lease,
            }),
        );
        leases.slice(0, -1).forEach(({ settle }) => settle({ state: "ready" }));
        leases.at(-1)?.settle({ state: "ready" });
        await Promise.all(completions);

        const tailCalls = calls.filter(
            (entry) => entry.request.tail.length > 0,
        );
        assert.equal(tailCalls.length, 1);
        assert.equal(tailCalls[0].request.generation, skips);
        assert.deepEqual(tailCalls[0].request.tail, [
            `tail-${skips - 1}-1`,
            `tail-${skips - 1}-2`,
        ]);
    });
}
