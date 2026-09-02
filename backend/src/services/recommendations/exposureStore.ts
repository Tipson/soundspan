import type { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import {
    recordRecommendationExposures,
    recordRecommendationPlaybackOutcome,
} from "../../metrics";
import type { RecommendationExposureMetricInput } from "../../metrics/recommendationMetrics";
import { logger } from "../../utils/logger";
import type {
    RecommendationDirection,
    RecommendationExposureSignal,
    RecommendationMood,
    RecommendationSurface,
    ScoredRecommendation,
} from "./types";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const exposureLogger = logger.child("RecommendationExposureStore");

interface ExposureCreateInput {
    userId: string;
    canonicalRecordingId: string | null;
    canonicalKey: string;
    artistKey: string;
    provider: string;
    providerTrackId: string;
    source: string;
    position: number;
    score: number;
}

interface GenerationCreateInput {
    userId: string;
    sessionId: string;
    surface: RecommendationSurface;
    direction: RecommendationDirection;
    mood: RecommendationMood | null;
    cursor: number;
    algorithm: string;
    served: boolean;
    degradedSources: string[];
    latencyMs: number;
    context?: Record<string, unknown>;
    exposures: ExposureCreateInput[];
}

interface PlaybackAttributionInput {
    userId: string;
    provider: string;
    providerTrackId: string;
    playedAt: Date;
    listenedSeconds: number | null;
    completionRatio: number | null;
    outcome: string | null;
    generationId?: string | null;
}

type ExposureOutcomeUpdate = Pick<
    PlaybackAttributionInput,
    "playedAt" | "listenedSeconds" | "completionRatio" | "outcome"
>;

interface ViewedTrackIdentity {
    provider: string;
    providerTrackId: string;
}

interface ExposureStoreDependencies {
    createGeneration: (input: GenerationCreateInput) => Promise<{ id: string }>;
    loadRecentExposures: (
        userId: string,
        since: Date,
    ) => Promise<RecommendationExposureSignal[]>;
    findAttributableExposure: (
        userId: string,
        provider: string,
        providerTrackId: string,
        since: Date,
        playedAt: Date,
    ) => Promise<{ id: string } | null>;
    findDirectExposure?: (
        userId: string,
        generationId: string,
        provider: string,
        providerTrackId: string,
    ) => Promise<{ id: string } | null>;
    markViewedExposures?: (
        userId: string,
        generationId: string,
        viewedAt: Date,
        tracks: ViewedTrackIdentity[],
    ) => Promise<number>;
    markExposureViewedIfMissing?: (
        exposureId: string,
        viewedAt: Date,
    ) => Promise<void>;
    updateExposure: (id: string, data: ExposureOutcomeUpdate) => Promise<void>;
}

export interface RecommendationExposureMetricsRecorder {
    recordExposures(input: RecommendationExposureMetricInput): void;
    recordPlaybackOutcome(outcome: string | null): void;
}

const defaultMetricsRecorder: RecommendationExposureMetricsRecorder = {
    recordExposures: recordRecommendationExposures,
    recordPlaybackOutcome: recordRecommendationPlaybackOutcome,
};

export interface RecordRecommendationGenerationInput {
    userId: string;
    sessionId: string;
    surface: RecommendationSurface;
    direction: RecommendationDirection;
    mood: RecommendationMood | null;
    cursor: number;
    algorithm: string;
    served: boolean;
    degradedSources: string[];
    latencyMs: number;
    context?: Record<string, unknown>;
    recommendations: ScoredRecommendation[];
}

function providerIdentity(recommendation: ScoredRecommendation): {
    provider: string;
    providerTrackId: string;
} | null {
    const { track } = recommendation;
    if (track.provider.youtubeVideoId) {
        return {
            provider: "youtube",
            providerTrackId: track.provider.youtubeVideoId,
        };
    }
    if (track.provider.tidalTrackId !== null) {
        return {
            provider: "tidal",
            providerTrackId: String(track.provider.tidalTrackId),
        };
    }
    if (track.source === "library") {
        return { provider: "library", providerTrackId: track.id };
    }
    return null;
}

function normalizedArtistKey(value: string): string {
    return value
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLocaleLowerCase("en-US");
}

export class RecommendationExposureStore {
    constructor(
        private readonly dependencies: ExposureStoreDependencies,
        private readonly metrics: RecommendationExposureMetricsRecorder = defaultMetricsRecorder,
    ) {}

    async loadRecent(
        userId: string,
        now: Date,
    ): Promise<RecommendationExposureSignal[]> {
        return this.dependencies.loadRecentExposures(
            userId,
            new Date(now.getTime() - SEVEN_DAYS_MS),
        );
    }

    async record(input: RecordRecommendationGenerationInput): Promise<string> {
        const exposures = input.recommendations.flatMap(
            (recommendation, position) => {
                const identity = providerIdentity(recommendation);
                if (!identity) return [];
                return [
                    {
                        userId: input.userId,
                        canonicalRecordingId:
                            recommendation.track.canonicalRecordingId ?? null,
                        canonicalKey: recommendation.track.canonicalKey,
                        artistKey: normalizedArtistKey(
                            recommendation.track.artist.name,
                        ),
                        ...identity,
                        source:
                            recommendation.track.candidateSources.join("+") ||
                            "unknown",
                        position,
                        score: recommendation.score,
                    },
                ];
            },
        );
        const generation = await this.dependencies.createGeneration({
            userId: input.userId,
            sessionId: input.sessionId,
            surface: input.surface,
            direction: input.direction,
            mood: input.mood,
            cursor: input.cursor,
            algorithm: input.algorithm,
            served: input.served,
            degradedSources: input.degradedSources,
            latencyMs: input.latencyMs,
            context: input.context,
            exposures,
        });
        try {
            this.metrics.recordExposures({
                surface: input.surface,
                algorithm: input.algorithm,
                served: input.served,
                count: exposures.length,
            });
        } catch (error) {
            exposureLogger.warn("exposure telemetry failed", {
                surface: input.surface,
                algorithm: input.algorithm,
                error,
            });
        }
        return generation.id;
    }

    async attributePlayback(input: PlaybackAttributionInput): Promise<void> {
        const directExposure =
            input.generationId && this.dependencies.findDirectExposure
                ? await this.dependencies.findDirectExposure(
                      input.userId,
                      input.generationId,
                      input.provider,
                      input.providerTrackId,
                  )
                : null;
        const exposure =
            directExposure ??
            (await this.dependencies.findAttributableExposure(
                input.userId,
                input.provider,
                input.providerTrackId,
                new Date(input.playedAt.getTime() - SEVEN_DAYS_MS),
                input.playedAt,
            ));
        if (!exposure) return;
        await this.dependencies.markExposureViewedIfMissing?.(
            exposure.id,
            input.playedAt,
        );
        await this.dependencies.updateExposure(exposure.id, {
            playedAt: input.playedAt,
            listenedSeconds: input.listenedSeconds,
            completionRatio: input.completionRatio,
            outcome: input.outcome,
        });
        try {
            this.metrics.recordPlaybackOutcome(input.outcome);
        } catch (error) {
            exposureLogger.warn("playback telemetry failed", {
                provider: input.provider,
                outcome: input.outcome,
                error,
            });
        }
    }

    async markViewed(input: {
        userId: string;
        generationId: string;
        viewedAt: Date;
        tracks: ViewedTrackIdentity[];
    }): Promise<number> {
        if (
            !this.dependencies.markViewedExposures ||
            input.tracks.length === 0
        ) {
            return 0;
        }
        return this.dependencies.markViewedExposures(
            input.userId,
            input.generationId,
            input.viewedAt,
            input.tracks,
        );
    }

    /** Explicit taste semantics shared by ranker training and metrics. */
    tasteDeltaForOutcome(
        outcome: string | null,
        completionRatio: number | null,
        listenedSeconds: number | null,
    ): number {
        if (outcome === "failed") return 0;
        if (
            outcome === "skipped" &&
            ((completionRatio ?? 0) <= 0.2 || (listenedSeconds ?? 0) < 30)
        ) {
            return -1;
        }
        if (outcome === "completed" || (completionRatio ?? 0) >= 0.85) {
            return 1;
        }
        if (outcome === "meaningful" || (listenedSeconds ?? 0) >= 240) {
            return 0.5;
        }
        return 0;
    }
}

export const recommendationExposureStore = new RecommendationExposureStore({
    createGeneration: async (input) =>
        prisma.recommendationGeneration.create({
            data: {
                userId: input.userId,
                sessionId: input.sessionId,
                surface: input.surface,
                direction: input.direction,
                mood: input.mood,
                cursor: input.cursor,
                algorithm: input.algorithm,
                served: input.served,
                degradedSources: input.degradedSources,
                latencyMs: input.latencyMs,
                context: input.context as Prisma.InputJsonObject | undefined,
                exposures: { create: input.exposures },
            },
            select: { id: true },
        }),
    loadRecentExposures: (userId, since) =>
        prisma.recommendationExposure
            .findMany({
                where: {
                    userId,
                    viewedAt: { gte: since },
                    generation: { served: true },
                },
                orderBy: { viewedAt: "desc" },
                select: { canonicalKey: true, viewedAt: true },
            })
            .then((rows) =>
                rows.map((row) => ({
                    canonicalKey: row.canonicalKey,
                    exposedAt: row.viewedAt!,
                })),
            ),
    findDirectExposure: (userId, generationId, provider, providerTrackId) =>
        prisma.recommendationExposure.findFirst({
            where: {
                userId,
                generationId,
                provider,
                providerTrackId,
                generation: { served: true, userId },
            },
            select: { id: true },
        }),
    findAttributableExposure: (
        userId,
        provider,
        providerTrackId,
        since,
        playedAt,
    ) =>
        prisma.recommendationExposure.findFirst({
            where: {
                userId,
                provider,
                providerTrackId,
                viewedAt: { gte: since, lte: playedAt },
                generation: { served: true },
            },
            orderBy: { viewedAt: "desc" },
            select: { id: true },
        }),
    markViewedExposures: async (userId, generationId, viewedAt, tracks) => {
        const result = await prisma.recommendationExposure.updateMany({
            where: {
                userId,
                generationId,
                viewedAt: null,
                generation: { served: true, userId },
                OR: tracks.map((track) => ({
                    provider: track.provider,
                    providerTrackId: track.providerTrackId,
                })),
            },
            data: { viewedAt },
        });
        return result.count;
    },
    markExposureViewedIfMissing: async (exposureId, viewedAt) => {
        await prisma.recommendationExposure.updateMany({
            where: { id: exposureId, viewedAt: null },
            data: { viewedAt },
        });
    },
    updateExposure: async (id, data) => {
        await prisma.recommendationExposure.update({
            where: { id },
            data,
        });
    },
});
