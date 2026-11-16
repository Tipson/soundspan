import { Registry } from "prom-client";

test("dispatch metrics use finite anonymous labels and keep maintenance separate from legacy", async () => {
    const {
        createPlayScrobbleDispatchMetrics,
    } = require("../playScrobbleDispatchMetrics");
    const registry = new Registry();
    const metrics = createPlayScrobbleDispatchMetrics(registry);
    metrics.recordOutcome("listenbrainz", "SUBMITTED", "ack_submitted");
    metrics.recordOutcome("private-owner", "private-title", "private-token");
    metrics.recordMaintenance({
        recovered: 2,
        expired: 1,
        enqueued: 3,
        enqueueFailures: 4,
        receipts: 5,
        purged: 6,
        oldestDueSeconds: 7,
        durationMs: 50,
    });
    const output = await registry.metrics();
    expect(output).toContain(
        'service="listenbrainz",state="SUBMITTED",reason="ack_submitted"',
    );
    expect(output).toContain('service="other",state="other",reason="other"');
    expect(output).toContain("soundspan_play_dispatch_oldest_due_seconds 7");
    expect(output).toContain('kind="receipts"} 5');
    expect(output).not.toMatch(
        /private-owner|private-title|private-token|forwarding_total/,
    );
});
