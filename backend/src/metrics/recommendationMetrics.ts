import { Counter, Histogram, type Registry } from "prom-client";
import type { RecommendationSurface } from "../services/recommendations/types";

export type RecommendationDelivery = "served" | "shadow";
export type RecommendationMetricAlgorithm =
    | "baseline-v1"
    | "hybrid-v2"
    | "other";
export type RecommendationPlaybackOutcome =
    | "completed"
    | "meaningful"
    | "skipped"
    | "failed"
    | "other";

export interface RecommendationGenerationMetricInput {
    surface: RecommendationSurface;
    algorithm: string;
    served: boolean;
    latencyMs: number;
    degradedSourceCount: number;
}

export interface RecommendationExposureMetricInput {
    surface: RecommendationSurface;
    algorithm: string;
    served: boolean;
    count: number;
}

type GenerationLabels = "surface" | "algorithm" | "delivery";

/** Bounded Prometheus instruments for recommendation quality operation. */
export interface RecommendationMetrics {
    generations: Counter<GenerationLabels>;
    generationDuration: Histogram<GenerationLabels>;
    degradedSources: Counter<GenerationLabels>;
    exposures: Counter<GenerationLabels>;
    playbackOutcomes: Counter<"outcome">;
    recordGeneration(input: RecommendationGenerationMetricInput): void;
    recordExposures(input: RecommendationExposureMetricInput): void;
    recordPlaybackOutcome(outcome: string | null): void;
}

function normalizeAlgorithm(value: string): RecommendationMetricAlgorithm {
    if (value === "baseline-v1" || value === "hybrid-v2") return value;
    return "other";
}

function normalizePlaybackOutcome(
    value: string | null,
): RecommendationPlaybackOutcome {
    switch (value) {
        case "completed":
        case "meaningful":
        case "skipped":
        case "failed":
            return value;
        default:
            return "other";
    }
}

function delivery(served: boolean): RecommendationDelivery {
    return served ? "served" : "shadow";
}

function boundedCount(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Registers recommendation metrics against one process-local registry. */
export function createRecommendationMetrics(
    registry: Registry,
): RecommendationMetrics {
    const generations = new Counter({
        name: "soundspan_recommendation_generations_total",
        help: "Persisted recommendation generations by surface, algorithm and delivery state.",
        labelNames: ["surface", "algorithm", "delivery"] as const,
        registers: [registry],
    });
    const generationDuration = new Histogram({
        name: "soundspan_recommendation_generation_seconds",
        help: "Recommendation generation latency in seconds.",
        labelNames: ["surface", "algorithm", "delivery"] as const,
        buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
        registers: [registry],
    });
    const degradedSources = new Counter({
        name: "soundspan_recommendation_degraded_sources_total",
        help: "Optional recommendation sources degraded while producing persisted generations.",
        labelNames: ["surface", "algorithm", "delivery"] as const,
        registers: [registry],
    });
    const exposures = new Counter({
        name: "soundspan_recommendation_exposures_total",
        help: "Persisted recommendation exposures by surface, algorithm and delivery state.",
        labelNames: ["surface", "algorithm", "delivery"] as const,
        registers: [registry],
    });
    const playbackOutcomes = new Counter({
        name: "soundspan_recommendation_playback_outcomes_total",
        help: "Attributed recommendation playback outcomes.",
        labelNames: ["outcome"] as const,
        registers: [registry],
    });

    return {
        generations,
        generationDuration,
        degradedSources,
        exposures,
        playbackOutcomes,
        recordGeneration(input): void {
            const labels = {
                surface: input.surface,
                algorithm: normalizeAlgorithm(input.algorithm),
                delivery: delivery(input.served),
            };
            generations.inc(labels);
            generationDuration.observe(
                labels,
                Number.isFinite(input.latencyMs)
                    ? Math.max(0, input.latencyMs) / 1_000
                    : 0,
            );
            degradedSources.inc(
                labels,
                boundedCount(input.degradedSourceCount),
            );
        },
        recordExposures(input): void {
            exposures.inc(
                {
                    surface: input.surface,
                    algorithm: normalizeAlgorithm(input.algorithm),
                    delivery: delivery(input.served),
                },
                boundedCount(input.count),
            );
        },
        recordPlaybackOutcome(outcome): void {
            playbackOutcomes.inc({
                outcome: normalizePlaybackOutcome(outcome),
            });
        },
    };
}
