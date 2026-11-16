import assert from "node:assert/strict";
import test from "node:test";
import {
    captureRecommendationFeedback,
    reconcileRecommendationFeedback,
    registerRecommendationFeedbackOwner,
    notifyRecommendationFeedbackChange,
    subscribeRecommendationFeedbackChanges,
} from "../../lib/audio/recommendationFeedbackBridge";
import { RecommendationQueueFeedback } from "../../lib/audio/recommendationQueueFeedback";

function fixture() {
    const guard = new RecommendationQueueFeedback();
    let failures = 0;
    const owner = {
        begin: (
            trackId: string,
            signal: "thumbs_up" | "thumbs_down" | "clear",
        ) => guard.begin({ trackId, signal, scope: "session:one" }),
        reconcile: guard.reconcile.bind(guard),
        reportFailure: () => {
            failures++;
        },
    };
    return { guard, owner, failures: () => failures };
}

test("queue receipts stay with their original owner, including delayed disposal", () => {
    const first = fixture();
    const disposeFirst = registerRecommendationFeedbackOwner(first.owner);
    const old = captureRecommendationFeedback("song", "thumbs_down")!;
    const second = fixture();
    const disposeSecond = registerRecommendationFeedbackOwner(second.owner);
    try {
        disposeFirst();
        assert.equal(reconcileRecommendationFeedback(old, "clear"), false);
        const fresh = captureRecommendationFeedback("song", "thumbs_down")!;
        assert.equal(
            reconcileRecommendationFeedback(fresh, "thumbs_down"),
            true,
        );
        assert.equal(second.guard.toCheckpoint().exclusions.length, 1);
    } finally {
        disposeFirst();
        disposeSecond();
    }
    assert.equal(captureRecommendationFeedback("song", "thumbs_down"), null);
});

test("a newer clear defeats an old negative ACK through the same owner", () => {
    const current = fixture();
    const dispose = registerRecommendationFeedbackOwner(current.owner);
    try {
        const negative = captureRecommendationFeedback("song", "thumbs_down")!;
        const clear = captureRecommendationFeedback("song", "clear")!;
        assert.equal(reconcileRecommendationFeedback(clear, "clear"), true);
        assert.equal(
            reconcileRecommendationFeedback(negative, "thumbs_down"),
            false,
        );
        assert.equal(current.guard.toCheckpoint().exclusions.length, 0);
    } finally {
        dispose();
    }
});

test("queue effect failures are reported without blocking preference persistence", () => {
    let failures = 0;
    const dispose = registerRecommendationFeedbackOwner({
        begin: () => {
            throw new Error("queue effect failed");
        },
        reconcile: () => {
            throw new Error("queue effect failed");
        },
        reportFailure: () => {
            failures++;
        },
    });
    try {
        assert.equal(
            captureRecommendationFeedback("song", "thumbs_down"),
            null,
        );
        assert.equal(failures, 1);
    } finally {
        dispose();
    }
});

test("a registration changed synchronously during capture cannot lend its receipt", () => {
    const replacement = fixture();
    let disposeReplacement = () => {};
    const dispose = registerRecommendationFeedbackOwner({
        ...replacement.owner,
        begin: (id, signal) => {
            disposeReplacement = registerRecommendationFeedbackOwner(
                replacement.owner,
            );
            return replacement.owner.begin(id, signal);
        },
    });
    try {
        assert.equal(
            captureRecommendationFeedback("song", "thumbs_down"),
            null,
        );
    } finally {
        dispose();
        disposeReplacement();
    }
});

test("feedback listeners run synchronously, isolate failures and retire on disposal", () => {
    const current = fixture();
    const unregister = registerRecommendationFeedbackOwner(current.owner);
    const calls: string[] = [];
    const broken = subscribeRecommendationFeedbackChanges(() => {
        throw new Error("speculative cancellation failed");
    });
    const healthy = subscribeRecommendationFeedbackChanges(() => {
        calls.push("updated");
    });
    try {
        notifyRecommendationFeedbackChange();
        assert.deepEqual(calls, ["updated"]);
        assert.equal(current.failures(), 1);
        healthy();
        broken();
        notifyRecommendationFeedbackChange();
        assert.deepEqual(calls, ["updated"]);
    } finally {
        healthy();
        broken();
        unregister();
    }
});
