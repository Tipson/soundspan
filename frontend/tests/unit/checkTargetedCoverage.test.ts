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

function coverageOutput(
    activityUncovered: string,
    activityLine = "95.54",
    activityBranch = "95.35",
): string {
    return [
        ...requiredTests.map((name) => `✔ ${name}`),
        "ℹ fail 0",
        "ℹ start of coverage report",
        `ℹ activityPanelTabs.ts | ${activityLine} | ${activityBranch} | 100.00 | ${activityUncovered}`,
        "ℹ socialNavigation.ts | 100.00 | 93.75 | 100.00 | ",
        "ℹ playbackHistoryConfig.ts | 100.00 | 94.12 | 100.00 | ",
        "ℹ end of coverage report",
    ].join("\n");
}

test("targeted coverage accepts only the known LF source-map artifact", () => {
    const result = spawnSync(process.execPath, [checkerPath], {
        encoding: "utf8",
        input: coverageOutput("108-112"),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /targeted coverage check passed/);
});

test("targeted coverage accepts the current Node 24 source-map artifact", () => {
    const result = spawnSync(process.execPath, [checkerPath], {
        encoding: "utf8",
        input: coverageOutput("126-130", "96.15", "95.83"),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /targeted coverage check passed/);
});

test("targeted coverage accepts the Windows Node 24 source-map artifact", () => {
    const result = spawnSync(process.execPath, [checkerPath], {
        encoding: "utf8",
        input: coverageOutput("124-128", "96.15", "95.83"),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /targeted coverage check passed/);
});

test("targeted coverage rejects a different uncovered range", () => {
    const result = spawnSync(process.execPath, [checkerPath], {
        encoding: "utf8",
        input: coverageOutput("107-112"),
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /coverage drifted|uncovered source lines/);
});
