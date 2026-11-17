import assert from "node:assert/strict";
import { test } from "node:test";
import { mixSnapshotDetails } from "../../features/home/mixSnapshot";

test("fresh daypart check is labelled as a check without inventing a composition date", () => {
    const details = mixSnapshotDetails({
        checkedAt: "2026-11-17T08:00:00.000Z",
        compositionKey: `daypart-v1:${"a".repeat(64)}`,
        reasons: ["pool_limited"],
    });
    assert.equal(details.dateTime, "2026-11-17T08:00:00.000Z");
    assert.match(details.dateLabel ?? "", /^Проверено в /);
    assert.doesNotMatch(details.dateLabel ?? "", /Состав/);
    assert.match(details.detail ?? "", /меньше подходящих/);
});

test("persisted daily and weekly composition dates retain their original semantics", () => {
    assert.match(
        mixSnapshotDetails({
            generatedAt: "2026-11-01T08:00:00Z",
            checkedAt: "2026-11-17T08:00:00Z",
        }).dateLabel ?? "",
        /^Состав от /,
    );
    assert.deepEqual(mixSnapshotDetails({ checkedAt: "bad", reasons: [] }), {});
    assert.deepEqual(
        mixSnapshotDetails({
            checkedAt: "2026-11-17T08:00:00Z",
            compositionKey: "untrusted-key",
        }),
        {},
    );
});

test("daypart check accepts an explicit offset but rejects normalized invalid calendar dates", () => {
    assert.deepEqual(
        mixSnapshotDetails({ checkedAt: "2026-02-30T08:00:00Z" }),
        {},
    );
    assert.equal(
        mixSnapshotDetails({ checkedAt: "2026-11-17T08:00:00+02:00" }).dateTime,
        "2026-11-17T08:00:00+02:00",
    );
});
