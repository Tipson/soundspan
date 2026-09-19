import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checkerPath = fileURLToPath(
    new URL("../../scripts/check-targeted-coverage.mjs", import.meta.url),
);

const requiredTests = [
    "getActivityPanelBadgeState keeps active badge when admin activity is the only signal",
    "resolveActivityTab uses notifications as the default fallback",
    "hasMyHistoryLink short-circuits when my-history is the first entry",
    "getImpactedHistoryCount returns the past-week count",
    "getImpactedHistoryCount returns the all-time count",
    "getImpactedHistoryCount preserves zero-valued weekly ranges",
];

function coverageOutput({
    activityLine = "100.00",
    activityBranch = "100.00",
    activityFunctions = "100.00",
    activityUncovered = "",
    includeEnd = true,
    includeActivity = true,
    duplicateActivity = false,
    failCount = 0,
}: {
    activityLine?: string;
    activityBranch?: string;
    activityFunctions?: string;
    activityUncovered?: string;
    includeEnd?: boolean;
    includeActivity?: boolean;
    duplicateActivity?: boolean;
    failCount?: number;
} = {}): string {
    const activityRow = `ℹ activityPanelTabs.ts | ${activityLine} | ${activityBranch} | ${activityFunctions} | ${activityUncovered}`;

    return [
        ...requiredTests.map((name) => `✔ ${name}`),
        `ℹ fail ${failCount}`,
        "ℹ start of coverage report",
        ...(includeActivity ? [activityRow] : []),
        ...(duplicateActivity ? [activityRow] : []),
        "ℹ socialNavigation.ts | 100.00 | 100.00 | 100.00 | ",
        "ℹ playbackHistoryConfig.ts | 100.00 | 100.00 | 100.00 | ",
        ...(includeEnd ? ["ℹ end of coverage report"] : []),
    ].join("\n");
}

function runChecker(input: string) {
    return spawnSync(process.execPath, [checkerPath], {
        encoding: "utf8",
        input,
    });
}

test("targeted coverage accepts complete 100 percent native coverage", () => {
    const result = runChecker(coverageOutput());

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /strict native coverage check passed/);
});

test("targeted coverage rejects the former source-map artifact allowance", () => {
    const result = runChecker(
        coverageOutput({
            activityLine: "96.15",
            activityBranch: "95.83",
            activityUncovered: "126-130",
        }),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be exactly 100/);
});

test("targeted coverage rejects any branch deficit", () => {
    const result = runChecker(coverageOutput({ activityBranch: "99.99" }));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be exactly 100/);
});

test("targeted coverage rejects an incomplete report", () => {
    const result = runChecker(coverageOutput({ includeEnd: false }));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /coverage report was incomplete/);
});

test("targeted coverage rejects a missing target row", () => {
    const result = runChecker(coverageOutput({ includeActivity: false }));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /coverage row missing/);
});

test("targeted coverage rejects duplicate target rows", () => {
    const result = runChecker(coverageOutput({ duplicateActivity: true }));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /duplicate coverage rows/);
});

test("targeted coverage rejects a non-passing native test summary", () => {
    const result = runChecker(coverageOutput({ failCount: 1 }));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /one or more tests failed/);
});

test("targeted coverage rejects a missing required branch test", () => {
    const output = coverageOutput().replace(`${requiredTests[0]}\n`, "");
    const result = runChecker(output);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing required branch test/);
});
