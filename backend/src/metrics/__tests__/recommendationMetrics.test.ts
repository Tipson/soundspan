import { Registry } from "prom-client";
import { createRecommendationMetrics } from "../recommendationMetrics";

describe("recommendation metrics", () => {
    it("records bounded generation, degradation, exposure and playback telemetry", async () => {
        const registry = new Registry();
        const metrics = createRecommendationMetrics(registry);

        metrics.recordGeneration({
            surface: "wave",
            algorithm: "hybrid-v2",
            served: false,
            latencyMs: 125,
            degradedSourceCount: 2,
        });
        metrics.recordExposures({
            surface: "wave",
            algorithm: "hybrid-v2",
            served: false,
            count: 4,
        });
        metrics.recordPlaybackOutcome("failed");
        metrics.recordPlaybackOutcome("provider-specific-unknown");

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_recommendation_generations_total{surface="wave",algorithm="hybrid-v2",delivery="shadow"} 1',
        );
        expect(exposition).toContain(
            'soundspan_recommendation_generation_seconds_sum{surface="wave",algorithm="hybrid-v2",delivery="shadow"} 0.125',
        );
        expect(exposition).toContain(
            'soundspan_recommendation_degraded_sources_total{surface="wave",algorithm="hybrid-v2",delivery="shadow"} 2',
        );
        expect(exposition).toContain(
            'soundspan_recommendation_exposures_total{surface="wave",algorithm="hybrid-v2",delivery="shadow"} 4',
        );
        expect(exposition).toContain(
            'soundspan_recommendation_playback_outcomes_total{outcome="failed"} 1',
        );
        expect(exposition).toContain(
            'soundspan_recommendation_playback_outcomes_total{outcome="other"} 1',
        );
    });
});
