/** Require all core scenarios to pass without skips, retries or expected failures. */
export function assertCoreJourneyReport(report) {
    const stats = report?.stats;
    const tests = [];
    function visit(suite) {
        for (const spec of suite.specs ?? []) tests.push(...(spec.tests ?? []));
        for (const child of suite.suites ?? []) visit(child);
    }
    for (const suite of report?.suites ?? []) visit(suite);
    if (!stats || stats.expected < 8 || tests.length !== stats.expected) {
        throw new Error(
            "Core journeys require a complete run of at least eight scenarios",
        );
    }
    if (
        (report.errors?.length ?? 0) ||
        stats.unexpected !== 0 ||
        stats.skipped !== 0 ||
        stats.flaky !== 0
    ) {
        throw new Error(
            "Core journeys reject errors, failures, skips and flaky successes",
        );
    }
    for (const test of tests) {
        if (
            test.results?.length !== 1 ||
            test.results[0].status !== "passed" ||
            test.results[0].retry !== 0
        ) {
            throw new Error("Every core journey must pass on a single attempt");
        }
    }
    return tests.length;
}
