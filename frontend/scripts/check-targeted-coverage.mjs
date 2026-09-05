import process from "node:process";

const input = await new Promise((resolve) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
        buffer += chunk;
    });
    process.stdin.on("end", () => resolve(buffer));
});

const reportStartMarker = "start of coverage report";
const reportEndMarker = "end of coverage report";
const reportStart = input.indexOf(reportStartMarker);
if (reportStart === -1) {
    console.error(
        "targeted coverage check failed: raw coverage report was not produced",
    );
    process.exit(1);
}

const reportEnd = input.indexOf(reportEndMarker, reportStart);
if (reportEnd === -1) {
    console.error(
        "targeted coverage check failed: coverage report was incomplete",
    );
    process.exit(1);
}

const failMatches = [...input.matchAll(/(?:ℹ|#)\s+fail\s+(\d+)/gu)];
if (failMatches.length === 0 || failMatches.some((match) => match[1] !== "0")) {
    console.error("targeted coverage check failed: one or more tests failed");
    process.exit(1);
}

const requiredTests = [
    "getActivityPanelBadgeState keeps active badge when admin activity is the only signal",
    "resolveActivityTab uses notifications as the default fallback",
    "hasMyHistoryLink short-circuits when my-history is the first entry",
    "getImpactedHistoryCount returns the past-week count",
    "getImpactedHistoryCount returns the all-time count",
    "getImpactedHistoryCount preserves zero-valued weekly ranges",
];

for (const testName of requiredTests) {
    if (!input.includes(testName)) {
        console.error(
            `targeted coverage check failed: missing required branch test "${testName}"`,
        );
        process.exit(1);
    }
}

const targetFiles = [
    "activityPanelTabs.ts",
    "socialNavigation.ts",
    "playbackHistoryConfig.ts",
];
const report = input.slice(reportStart, reportEnd);
const coverageRows = report
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.includes("|"));

for (const file of targetFiles) {
    const rows = coverageRows.filter((line) => {
        const [name = ""] = line.split("|");
        return name.trim().endsWith(file);
    });
    if (rows.length === 0) {
        console.error(
            `targeted coverage check failed: coverage row missing for ${file}`,
        );
        process.exit(1);
    }
    if (rows.length !== 1) {
        console.error(
            `targeted coverage check failed: duplicate coverage rows for ${file}`,
        );
        process.exit(1);
    }

    const segments = rows[0].split("|").map((segment) => segment.trim());
    const [, lineText, branchText, funcsText, uncoveredText = ""] = segments;
    const percentages = [lineText, branchText, funcsText].map(Number);
    if (
        segments.length < 4 ||
        percentages.some(
            (percentage) => !Number.isFinite(percentage) || percentage !== 100,
        )
    ) {
        console.error(
            `targeted coverage check failed: ${file} line/branch/functions coverage must be exactly 100 (${lineText}/${branchText}/${funcsText})`,
        );
        process.exit(1);
    }
    if (uncoveredText.length > 0) {
        console.error(
            `targeted coverage check failed: ${file} reported uncovered source lines (${uncoveredText})`,
        );
        process.exit(1);
    }
}

console.log(
    "strict native coverage check passed: 100/100/100 for every target",
);
