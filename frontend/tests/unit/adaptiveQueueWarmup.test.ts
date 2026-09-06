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

test("queue advance retains already admitted overlapping tail while next is loading", async () => {
    const calls: TailWarmupReconcileRequest[] = [];
    const coordinator = new AdaptiveQueueWarmupCoordinator(
        "handoff",
        async (request) => {
            calls.push(request);
        },
    );
    const ready = deferredLease();
    ready.settle({ state: "ready" });
    await coordinator.reconcile({
        currentVideoId: "a",
        immediateVideoId: "b",
        tailVideoIds: ["c", "d"],
        connection: {},
        immediateLease: ready.lease,
    });
    const pending = deferredLease();
    const completion = coordinator.reconcile({
        currentVideoId: "b",
        immediateVideoId: "c",
        tailVideoIds: ["d", "e"],
        connection: {},
        immediateLease: pending.lease,
    });
    assert.deepEqual(
        calls.at(-1)?.tail,
        ["d"],
        "do not cancel and restart still-needed d; do not start new e yet",
    );
    pending.settle({ state: "ready" });
    await completion;
    assert.deepEqual(calls.at(-1)?.tail, ["d", "e"]);
    await coordinator.clear();
});

test("deferred network preparation retains only previously submitted queue interests", async () => {
    const calls: TailWarmupReconcileRequest[] = [];
    const coordinator = new AdaptiveQueueWarmupCoordinator(
        "deferred",
        async (request) => {
            calls.push(request);
        },
    );
    const ready = deferredLease();
    ready.settle({ state: "ready" });
    await coordinator.reconcile({
        currentVideoId: "a",
        immediateVideoId: "b",
        tailVideoIds: ["c", "d"],
        connection: {},
        immediateLease: ready.lease,
    });
    await coordinator.reconcile({
        currentVideoId: "b",
        immediateVideoId: "c",
        tailVideoIds: ["d", "e"],
        connection: {},
        immediateLease: null,
        retainOnly: true,
    });
    assert.deepEqual(calls.at(-1), {
        ownerId: "deferred",
        generation: 2,
        current: "b",
        immediate: "c",
        tail: ["d"],
    });
    await coordinator.reconcile({
        currentVideoId: "x",
        immediateVideoId: "y",
        tailVideoIds: ["d", "z"],
        connection: {},
        immediateLease: ready.lease,
        retainOnly: true,
    });
    assert.deepEqual(calls.at(-1), {
        ownerId: "deferred",
        generation: 3,
        current: null,
        immediate: null,
        tail: ["d"],
    });
    assert.equal(
        calls.length,
        4,
        "even a ready lease cannot admit new work in retain-only mode",
    );
    await coordinator.clear();
});

for (const reason of ["quality", "saveData", "clear"] as const) {
    test(`retained tail is released after ${reason}`, async () => {
        const calls: TailWarmupReconcileRequest[] = [];
        const coordinator = new AdaptiveQueueWarmupCoordinator(
            "release",
            async (request) => {
                calls.push(request);
            },
        );
        const ready = deferredLease();
        ready.settle({ state: "ready" });
        const input = {
            quality: "high",
            currentVideoId: "a",
            immediateVideoId: "b",
            tailVideoIds: ["c", "d"],
            connection: {},
            immediateLease: ready.lease,
        };
        await coordinator.reconcile(input);
        if (reason === "clear") await coordinator.clear();
        const pending = deferredLease();
        const completion = coordinator.reconcile({
            ...input,
            quality: reason === "quality" ? "low" : "high",
            connection: { saveData: reason === "saveData" },
            immediateLease: pending.lease,
        });
        assert.deepEqual(calls.at(-1)?.tail, []);
        pending.settle({ state: "cancelled" });
        await completion;
        await coordinator.clear();
    });
}

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

test("progress updates reuse one warmup generation before and after readiness", async () => {
    const calls: TailWarmupReconcileRequest[] = [];
    const signals: AbortSignal[] = [];
    const pending = deferredLease();
    const coordinator = new AdaptiveQueueWarmupCoordinator(
        "stable-player",
        async (request, signal) => {
            calls.push(request);
            signals.push(signal);
        },
    );
    const input = {
        currentVideoId: "current",
        immediateVideoId: "next",
        tailVideoIds: ["tail"],
        connection: {},
        immediateLease: pending.lease,
    };
    const completions = Array.from({ length: 100 }, () =>
        coordinator.reconcile({
            ...input,
            tailVideoIds: [...input.tailVideoIds],
        }),
    );
    assert.equal(calls.length, 1);
    assert.equal(signals[0].aborted, false);
    pending.settle({ state: "ready" });
    await Promise.all(completions);
    for (let index = 0; index < 100; index++)
        await coordinator.reconcile(input);
    assert.equal(calls.length, 2);
    await coordinator.reconcile({ ...input, tailVideoIds: ["changed"] });
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.at(-1)?.tail, ["changed"]);
});

test("repeated inactive updates send only one clear, and a new lease is not suppressed", async () => {
    const calls: TailWarmupReconcileRequest[] = [];
    const coordinator = new AdaptiveQueueWarmupCoordinator(
        "clear-player",
        async (request) => {
            calls.push(request);
        },
    );
    for (let index = 0; index < 100; index++) await coordinator.clear();
    assert.equal(calls.length, 1);
    const first = deferredLease();
    first.settle({ state: "ready" });
    const input = {
        currentVideoId: "current",
        immediateVideoId: "next",
        tailVideoIds: [],
        connection: {},
        immediateLease: first.lease,
    };
    await coordinator.reconcile(input);
    const second = deferredLease();
    second.settle({ state: "ready" });
    await coordinator.reconcile({ ...input, immediateLease: second.lease });
    assert.equal(calls.length, 3);
    await coordinator.clear();
    assert.equal(calls.length, 4);
});

test("unchanged warmup renews after sixty seconds instead of expiring or flooding", async (context) => {
    context.mock.timers.enable({ apis: ["Date"], now: 1000 });
    const calls: TailWarmupReconcileRequest[] = [];
    const coordinator = new AdaptiveQueueWarmupCoordinator(
        "renew-player",
        async (request) => {
            calls.push(request);
        },
    );
    const input = {
        currentVideoId: "current",
        immediateVideoId: null,
        tailVideoIds: [],
        connection: {},
        immediateLease: null,
    };
    await coordinator.reconcile(input);
    context.mock.timers.tick(59_999);
    await coordinator.reconcile(input);
    assert.equal(calls.length, 1);
    context.mock.timers.tick(1);
    await coordinator.reconcile(input);
    assert.equal(calls.length, 2);
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
