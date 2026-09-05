import { Registry } from "prom-client";
import { createPlaybackMetrics } from "../playbackMetrics";

describe("playback client metrics", () => {
    it("records bounded event, source, outcome and latency labels", async () => {
        const registry = new Registry();
        const metrics = createPlaybackMetrics(registry);

        metrics.record({
            event: "player.engine_startup",
            sourceType: "ytmusic",
            outcome: "audible",
            durationMs: 420,
        });
        metrics.record({
            event: "player.vendor_specific_event",
            sourceType: "unbounded-provider-id",
            outcome: "unbounded-error-message",
            durationMs: Number.NaN,
        });

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_playback_client_events_total{event="engine_startup",source="youtube",outcome="audible"} 1',
        );
        expect(exposition).toContain(
            'soundspan_playback_client_events_total{event="other",source="other",outcome="failed"} 1',
        );
        expect(exposition).toContain(
            'soundspan_playback_client_event_seconds_sum{event="engine_startup",source="youtube"} 0.42',
        );
        expect(exposition).not.toContain(
            'soundspan_playback_client_event_seconds_sum{event="other",source="other"}',
        );
    });

    it("counts every event but only measures valid explicit durations", async () => {
        const registry = new Registry();
        const metrics = createPlaybackMetrics(registry);

        for (const durationMs of [
            undefined,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
            -1,
            0,
            420,
        ]) {
            metrics.record({
                event: "player.audible_start",
                sourceType: "youtube",
                outcome: "audible",
                durationMs,
            });
        }

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_playback_client_events_total{event="audible_start",source="youtube",outcome="audible"} 7',
        );
        expect(exposition).toContain(
            'soundspan_playback_client_event_seconds_count{event="audible_start",source="youtube"} 2',
        );
        expect(exposition).toContain(
            'soundspan_playback_client_event_seconds_sum{event="audible_start",source="youtube"} 0.42',
        );
        expect(exposition).toContain(
            'soundspan_playback_client_event_seconds_bucket{le="0.05",event="audible_start",source="youtube"} 1',
        );
    });

    it("maps known failure reasons into a closed outcome vocabulary", async () => {
        const registry = new Registry();
        const metrics = createPlaybackMetrics(registry);

        metrics.record({
            event: "player.playback_error",
            sourceType: "device-offline",
            reason: "network_timeout",
        });
        metrics.record({
            event: "player.playback_cancelled",
            sourceType: "local",
            reason: "manual_track_change",
        });

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_playback_client_events_total{event="playback_error",source="device_offline",outcome="timeout"} 1',
        );
        expect(exposition).toContain(
            'soundspan_playback_client_events_total{event="playback_cancelled",source="local",outcome="cancelled"} 1',
        );
    });
});
