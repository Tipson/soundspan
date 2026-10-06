import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCoreJourneyReport } from "./core-journey-report.mjs";

function passedReport() {
    return {
        errors: [],
        stats: { expected: 8, unexpected: 0, skipped: 0, flaky: 0 },
        suites: [
            {
                suites: [
                    {
                        specs: Array.from({ length: 8 }, () => ({
                            tests: [
                                { results: [{ status: "passed", retry: 0 }] },
                            ],
                        })),
                    },
                ],
            },
        ],
    };
}

test("accepts a complete single-attempt passing run", () =>
    assert.equal(assertCoreJourneyReport(passedReport()), 8));
test("rejects a subset or empty run", () => {
    const report = passedReport();
    report.stats.expected = 7;
    assert.throws(() => assertCoreJourneyReport(report), /complete/);
    assert.throws(() => assertCoreJourneyReport({}), /complete/);
});
for (const field of ["unexpected", "skipped", "flaky"]) {
    test(`rejects ${field} rather than accepting partial green`, () => {
        const report = passedReport();
        report.stats[field] = 1;
        assert.throws(() => assertCoreJourneyReport(report));
    });
}
test("rejects expected-failure annotations and retry successes", () => {
    for (const result of [
        { status: "failed", retry: 0 },
        { status: "passed", retry: 1 },
    ]) {
        const report = passedReport();
        report.suites[0].suites[0].specs[0].tests[0].results = [result];
        assert.throws(() => assertCoreJourneyReport(report), /single attempt/);
    }
});
test("rejects inconsistent result counts and runner errors", () => {
    const report = passedReport();
    report.suites = [];
    assert.throws(() => assertCoreJourneyReport(report), /complete/);
    const runnerError = passedReport();
    runnerError.errors = [{ message: "Server failed" }];
    assert.throws(() => assertCoreJourneyReport(runnerError));
});
