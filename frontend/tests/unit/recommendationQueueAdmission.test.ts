import assert from "node:assert/strict";
import { test } from "node:test";
import {
    RecommendationQueueAdmission,
    type FiniteQueueAdmissionReference,
    type RecommendationQueueAdmissionResult,
} from "../../lib/audio/recommendationQueueAdmission";

const refs: readonly FiniteQueueAdmissionReference[] = [
    { source: "library", id: "track-a", generationId: "generation-a" },
    { source: "youtube", id: "AAAAAAAAAAA" },
];
const ready: RecommendationQueueAdmissionResult = {
    status: "ready",
    response: {
        version: 1,
        appliesTo: "recommended_future",
        decisions: [
            { source: "library", id: "track-a", state: "allowed" },
            { source: "youtube", id: "AAAAAAAAAAA", state: "denied" },
        ],
    },
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

test("pending preference writes all settle before one identical finite request is admitted", async () => {
    const calls: unknown[] = [];
    const coordinator = new RecommendationQueueAdmission(async (references) => {
        calls.push(references);
        return ready;
    }, "owner-a");
    const first = coordinator.beginPreferenceMutation();
    const second = coordinator.beginPreferenceMutation();
    const a = coordinator.readmit(refs);
    const b = coordinator.readmit(refs.map((ref) => ({ ...ref })));
    await flush();
    assert.equal(calls.length, 0);
    coordinator.settlePreferenceMutation(first);
    await flush();
    assert.equal(calls.length, 0);
    coordinator.settlePreferenceMutation(first);
    coordinator.settlePreferenceMutation(second);
    const [one, two] = await Promise.all([a, b]);
    assert.equal(calls.length, 1);
    assert.equal(one.status, "ready");
    assert.equal(two.status, "ready");
    assert.equal(coordinator.isCurrent(one.capture), true);
});

test("every preference begin fences a late reply even when like or clear changes no exclusion", async () => {
    const old = deferred<RecommendationQueueAdmissionResult>();
    let oldSignal: AbortSignal | undefined;
    let calls = 0;
    const coordinator = new RecommendationQueueAdmission(
        async (_refs, signal) => {
            calls++;
            if (calls === 1) {
                oldSignal = signal;
                return old.promise;
            }
            return ready;
        },
        "owner-a",
    );
    const capture = coordinator.capture();
    const pending = coordinator.readmit(refs);
    const like = coordinator.beginPreferenceMutation();
    assert.equal(coordinator.isCurrent(capture), false);
    assert.equal(oldSignal?.aborted, true);
    assert.equal((await pending).status, "superseded");
    old.resolve(ready);
    coordinator.settlePreferenceMutation(like);
    assert.equal((await coordinator.readmit(refs)).status, "ready");
    const next = coordinator.capture();
    const clear = coordinator.beginPreferenceMutation();
    assert.equal(coordinator.isCurrent(next), false);
    coordinator.settlePreferenceMutation(clear);
});

test("a newer mutation supersedes pending waiters rather than sharing across epochs", async () => {
    let calls = 0;
    const coordinator = new RecommendationQueueAdmission(async () => {
        calls++;
        return ready;
    }, "owner-a");
    const first = coordinator.beginPreferenceMutation();
    const old = coordinator.readmit(refs);
    const second = coordinator.beginPreferenceMutation();
    assert.equal((await old).status, "superseded");
    const current = coordinator.readmit(refs);
    coordinator.settlePreferenceMutation(second);
    await flush();
    assert.equal(calls, 0);
    coordinator.settlePreferenceMutation(first);
    assert.equal((await current).status, "ready");
    assert.equal(calls, 1);
});

test("lost or rejected preference ACK can settle in finally and cannot leave admission waiting", async () => {
    const coordinator = new RecommendationQueueAdmission(
        async () => ready,
        "owner-a",
    );
    const token = coordinator.beginPreferenceMutation();
    const pending = coordinator.readmit(refs);
    try {
        throw new Error("lost ACK");
    } catch {
        /* write failure belongs to the caller */
    } finally {
        coordinator.settlePreferenceMutation(token);
    }
    assert.equal((await pending).status, "ready");
});

test("owner replacement aborts old work and old settlement cannot release the new owner's pending write", async () => {
    const wire = deferred<RecommendationQueueAdmissionResult>();
    let signal: AbortSignal | undefined;
    const coordinator = new RecommendationQueueAdmission(
        async (_refs, value) => {
            signal = value;
            return wire.promise;
        },
        "owner-a",
    );
    const old = coordinator.readmit(refs);
    const oldToken = coordinator.beginPreferenceMutation();
    coordinator.setOwner("owner-b");
    const currentToken = coordinator.beginPreferenceMutation();
    const current = coordinator.readmit(refs);
    coordinator.settlePreferenceMutation(oldToken);
    await flush();
    assert.equal(signal?.aborted, true);
    assert.equal((await old).status, "superseded");
    coordinator.setOwner(null);
    assert.equal((await current).status, "superseded");
    coordinator.settlePreferenceMutation(currentToken);
    assert.equal((await coordinator.readmit(refs)).status, "unavailable");
});

test("explicit queue replacement retires captures and in-flight results while retaining owner writes", async () => {
    let calls = 0;
    const wire = deferred<RecommendationQueueAdmissionResult>();
    const coordinator = new RecommendationQueueAdmission(async () => {
        calls++;
        return wire.promise;
    }, "owner-a");
    const capture = coordinator.capture();
    const old = coordinator.readmit(refs);
    const token = coordinator.beginPreferenceMutation();
    coordinator.replaceQueue();
    assert.equal((await old).status, "superseded");
    assert.equal(coordinator.isCurrent(capture), false);
    const current = coordinator.readmit(refs);
    await flush();
    assert.equal(calls, 1);
    coordinator.settlePreferenceMutation(token);
    wire.resolve(ready);
    assert.equal((await current).status, "ready");
    assert.equal(calls, 2);
});

test("coalescing requires identical ordered refs and generation context and never caches a completed result", async () => {
    const wire = deferred<RecommendationQueueAdmissionResult>();
    const calls: unknown[] = [];
    const coordinator = new RecommendationQueueAdmission(async (value) => {
        calls.push(value);
        return wire.promise;
    }, "owner-a");
    const a = coordinator.readmit(refs);
    const b = coordinator.readmit([...refs].reverse());
    const c = coordinator.readmit([
        { ...refs[0], generationId: "other" },
        refs[1],
    ]);
    assert.equal(calls.length, 3);
    wire.resolve(ready);
    await Promise.all([a, b, c]);
    await coordinator.readmit(refs);
    assert.equal(calls.length, 4);
});

test("canceling an independently signaled caller settles it without canceling another caller", async () => {
    const wire = deferred<RecommendationQueueAdmissionResult>();
    let signal: AbortSignal | undefined;
    const coordinator = new RecommendationQueueAdmission(
        async (_refs, value) => {
            signal = value;
            return wire.promise;
        },
        "owner-a",
    );
    const controller = new AbortController();
    const a = coordinator.readmit(refs, controller.signal);
    const b = coordinator.readmit(refs);
    controller.abort();
    assert.equal((await a).status, "unavailable");
    assert.equal(signal?.aborted, false);
    wire.resolve(ready);
    assert.equal((await b).status, "ready");
});

test("canceling the last caller aborts wire work even if transport ignores the signal", async () => {
    let signal: AbortSignal | undefined;
    const coordinator = new RecommendationQueueAdmission(
        async (_refs, value) => {
            signal = value;
            return new Promise(() => {});
        },
        "owner-a",
    );
    const controller = new AbortController();
    const pending = coordinator.readmit(refs, controller.signal);
    controller.abort();
    assert.equal((await pending).status, "unavailable");
    assert.equal(signal?.aborted, true);
});

test("the total 17 second await includes pending writes and stalled transport without background retries", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    let signal: AbortSignal | undefined;
    const coordinator = new RecommendationQueueAdmission(
        async (_refs, value) => {
            calls++;
            signal = value;
            return new Promise(() => {});
        },
        "owner-a",
    );
    const token = coordinator.beginPreferenceMutation();
    const waiting = coordinator.readmit(refs);
    context.mock.timers.tick(16_000);
    coordinator.settlePreferenceMutation(token);
    assert.equal(calls, 1);
    context.mock.timers.tick(1_000);
    assert.equal((await waiting).status, "unavailable");
    assert.equal(signal?.aborted, true);
    context.mock.timers.tick(100_000);
    assert.equal(calls, 1);
});

test("failures and legacy status remain explicit transient outcomes and a new request may recover", async () => {
    let attempts = 0;
    const coordinator = new RecommendationQueueAdmission(async () => {
        if (++attempts === 1) throw new Error("network");
        if (attempts === 2) return { status: "legacy_exact" };
        return ready;
    }, "owner-a");
    assert.equal((await coordinator.readmit(refs)).status, "unavailable");
    assert.equal((await coordinator.readmit(refs)).status, "legacy_exact");
    assert.equal((await coordinator.readmit(refs)).status, "ready");
});

test("restart has no durable permission cache and over-limit batches never start work", async () => {
    let calls = 0;
    const request = async () => {
        calls++;
        return ready;
    };
    const first = new RecommendationQueueAdmission(request, "owner-a");
    await first.readmit(refs);
    const restarted = new RecommendationQueueAdmission(request, "owner-a");
    await restarted.readmit(refs);
    assert.equal(calls, 2);
    assert.equal(
        (await restarted.readmit(Array.from({ length: 101 }, () => refs[0])))
            .status,
        "unavailable",
    );
    assert.equal(calls, 2);
});
