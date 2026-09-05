import assert from "node:assert/strict";
import test from "node:test";
import {
    classifyPlaybackFailure,
    runMockPlaybackLoad,
    summarizeLatencySamples,
} from "../../playback-load-harness.mjs";

test("summarizes resolve, first-byte, and audible-gap latency with p50/p95", () => {
    const summary = summarizeLatencySamples([
        { resolveMs: 10, firstByteMs: 20, audibleGapMs: 30 },
        { resolveMs: 20, firstByteMs: 30, audibleGapMs: 40 },
        { resolveMs: 30, firstByteMs: 40, audibleGapMs: 50 },
        { resolveMs: 40, firstByteMs: 50, audibleGapMs: 60 },
    ]);

    assert.deepEqual(summary, {
        samples: 4,
        resolveMs: { p50: 25, p95: 38.5 },
        firstByteMs: { p50: 35, p95: 48.5 },
        audibleGapMs: { p50: 45, p95: 58.5 },
    });
});

test("classifies bounded playback failures without using provider messages as labels", () => {
    assert.equal(classifyPlaybackFailure({ status: 404 }), "unavailable");
    assert.equal(classifyPlaybackFailure({ status: 451 }), "unavailable");
    assert.equal(classifyPlaybackFailure({ status: 429 }), "rate_limit");
    assert.equal(classifyPlaybackFailure({ status: 504 }), "timeout");
    assert.equal(
        classifyPlaybackFailure({ errorName: "TimeoutError" }),
        "timeout",
    );
    assert.equal(
        classifyPlaybackFailure({ errorName: "AbortError" }),
        "cancelled",
    );
    assert.equal(
        classifyPlaybackFailure({ errorCode: "ECONNRESET" }),
        "network",
    );
    assert.equal(classifyPlaybackFailure({ status: 503 }), "failed");
});

test("loopback harness covers cold/warm, rapid skip, concurrency, timeout, and unavailable", async () => {
    const report = await runMockPlaybackLoad({ listeners: 12 });

    assert.equal(report.mode, "loopback-mock");
    assert.equal(report.listeners, 12);
    assert.match(report.measurementDefinitions.audibleGapMs, /synthetic/i);
    for (const name of ["coldStart", "warmStart", "concurrentListeners"]) {
        const scenario = report.scenarios[name];
        assert.equal(scenario.successes, 12);
        assert.equal(scenario.failures, 0);
        assert.equal(scenario.latency.samples, 12);
        for (const metric of ["resolveMs", "firstByteMs", "audibleGapMs"]) {
            assert.ok(scenario.latency[metric].p50 >= 0);
            assert.ok(
                scenario.latency[metric].p95 >= scenario.latency[metric].p50,
            );
        }
    }

    assert.equal(report.scenarios.rapidSkip.successes, 12);
    assert.deepEqual(report.scenarios.rapidSkip.errors, { cancelled: 24 });
    assert.deepEqual(report.scenarios.providerTimeout.errors, { timeout: 12 });
    assert.deepEqual(report.scenarios.providerUnavailable.errors, {
        unavailable: 12,
    });
    assert.equal(report.mockProvider.concurrentResolveJobs, 1);
    assert.equal(report.mockProvider.concurrentStreamJobs, 1);
    assert.ok(report.mockProvider.peakRequests >= 10);
    assert.ok(report.mockProvider.peakRequests <= report.listeners * 3);
});

test("loopback harness refuses listener counts outside the safe 1..20 bound", async () => {
    await assert.rejects(
        runMockPlaybackLoad({ listeners: 21 }),
        /between 1 and 20/,
    );
});
