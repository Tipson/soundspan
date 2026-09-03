import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOnlineAnalysisSnapshot } from "../../lib/api/onlineAnalysis";

const stage = { completed: 5, remaining: 5, failed: 1, completedLast24h: 2 };
const snapshot = {
    generatedAt: "2026-09-03T22:00:00Z",
    total: 10,
    enabled: true,
    activeAssets: 0,
    activeSpace: { id: "space", family: "dclap" },
    audio: stage,
    embeddings: stage,
    budget: {
        dailyLimit: 250,
        checkedToday: 258,
        concurrency: 2,
        resetsAt: "2026-09-04T00:00:00Z",
    },
};

test("accepts producer snapshot and preserves quota checks above the limit", () => {
    const data = parseOnlineAnalysisSnapshot(snapshot);
    assert.equal(data.budget.checkedToday, 258);
    assert.deepEqual(data.audio, stage);
});

test("supports unavailable telemetry and absent active embedding space", () => {
    const data = parseOnlineAnalysisSnapshot({
        ...snapshot,
        activeSpace: null,
        embeddings: null,
        budget: { ...snapshot.budget, checkedToday: null },
    });
    assert.equal(data.embeddings, null);
    assert.equal(data.budget.checkedToday, null);
});

test("rejects malformed or inconsistent totals rather than rendering misleading bars", () => {
    for (const value of [
        null,
        {},
        { ...snapshot, total: -1 },
        { ...snapshot, audio: { ...stage, completed: 15 } },
        { ...snapshot, generatedAt: "bad" },
    ]) {
        assert.throws(
            () => parseOnlineAnalysisSnapshot(value),
            /Invalid online analysis snapshot/,
        );
    }
});
