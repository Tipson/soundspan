import { createHash } from "node:crypto";
import { logger } from "../../utils/logger";
import { recordRecommendationGenerationMetrics } from "../../metrics";
import type { RecommendationGenerationMetricInput } from "../../metrics/recommendationMetrics";
import { rankRecommendationCandidates } from "./rankerV2";
import type {
    RecommendRequest,
    RecommendResult,
    RecommendationCandidate,
    RecommendationExposureSignal,
    ScoredRecommendation,
} from "./types";

const CANONICAL_RESOLUTION_BATCH_SIZE = 8;
const recommendationLogger = logger.child("RecommendationEngine");

export type RecommendationEngineMode = "baseline" | "shadow" | "active";

export interface RecommendationCandidateBatch {
    candidates: RecommendationCandidate[];
    nextCursor: number;
    degradedSources: string[];
}

export interface CanonicalRecommendationIdentity {
    id: string;
    canonicalKey: string;
}

export interface RecommendationTasteContext {
    positiveCentroids: readonly (readonly number[])[];
    negativeCentroids: readonly (readonly number[])[];
    sessionPositiveEmbedding?: readonly number[] | null;
    sessionNegativeEmbedding?: readonly number[] | null;
    sessionSignalCount?: number;
    contextCentroids?: readonly (readonly number[])[];
    moodEmbedding?: readonly number[] | null;
    degradedSources?: readonly string[];
}

export interface RecordEngineGenerationInput {
    userId: string;
    sessionId: string;
    surface: RecommendRequest["intent"]["surface"];
    direction: RecommendRequest["intent"]["direction"];
    mood: NonNullable<RecommendRequest["intent"]["mood"]> | null;
    cursor: number;
    algorithm: "baseline-v1" | "hybrid-v2";
    served: boolean;
    degradedSources: string[];
    latencyMs: number;
    context?: Record<string, unknown>;
    recommendations: ScoredRecommendation[];
}

export interface ScheduleRecommendationHotSetInput {
    userId: string;
    sessionId: string;
    surface: RecommendRequest["intent"]["surface"];
    candidates: RecommendationCandidate[];
}

export interface RecommendationEngineDependencies {
    mode: RecommendationEngineMode;
    hybridRolloutPercent: number;
    explorationRate: number;
    loadCandidates: (
        request: RecommendRequest,
    ) => Promise<RecommendationCandidateBatch>;
    resolveCanonical: (
        candidate: RecommendationCandidate,
    ) => Promise<CanonicalRecommendationIdentity>;
    enrichCandidates?: (
        candidates: RecommendationCandidate[],
    ) => Promise<RecommendationCandidate[]>;
    loadRecentExposures: (
        userId: string,
        now: Date,
    ) => Promise<RecommendationExposureSignal[]>;
    loadDislikedCanonicalKeys: (userId: string) => Promise<ReadonlySet<string>>;
    loadTasteContext: (
        userId: string,
        request: RecommendRequest,
    ) => Promise<RecommendationTasteContext>;
    recordGeneration: (input: RecordEngineGenerationInput) => Promise<string>;
    scheduleHotSet: (input: ScheduleRecommendationHotSetInput) => Promise<void>;
    now: () => Date;
}

function rolloutBucket(userId: string, sessionId: string): number {
    const digest = createHash("sha256")
        .update(`soundspan:hybrid-v2:${userId}:${sessionId}`)
        .digest();
    return digest.readUInt32BE(0) / 0x1_0000_0000;
}

function requestContext(request: RecommendRequest): Record<string, unknown> {
    const localHour = request.context?.localHour;
    const timeBucket =
        localHour === undefined
            ? undefined
            : localHour < 6
              ? "night"
              : localHour < 12
                ? "morning"
                : localHour < 18
                  ? "afternoon"
                  : "evening";
    return {
        ...request.context,
        ...(timeBucket ? { timeBucket } : {}),
    };
}

export interface RecommendationEngineMetricsRecorder {
    recordGeneration(input: RecommendationGenerationMetricInput): void;
}

const defaultMetricsRecorder: RecommendationEngineMetricsRecorder = {
    recordGeneration: recordRecommendationGenerationMetrics,
};

interface HybridContext {
    exposures: RecommendationExposureSignal[];
    dislikedCanonicalKeys: ReadonlySet<string>;
    taste: RecommendationTasteContext;
    degradedSources: string[];
}

function appendDegradedSource(target: string[], source: string): void {
    if (!target.includes(source)) target.push(source);
}

function hasPlayableIdentity(candidate: RecommendationCandidate): boolean {
    return Boolean(
        candidate.provider.youtubeVideoId ||
        candidate.provider.tidalTrackId !== null ||
        candidate.source === "library",
    );
}

function isExcluded(
    candidate: RecommendationCandidate,
    excludes: ReadonlySet<string>,
): boolean {
    if (excludes.size === 0) return false;
    const identities = [
        candidate.id,
        candidate.canonicalKey,
        candidate.canonicalRecordingId ?? "",
        candidate.provider.youtubeVideoId ?? "",
        candidate.provider.youtubeVideoId
            ? `yt:${candidate.provider.youtubeVideoId}`
            : "",
        candidate.provider.tidalTrackId === null
            ? ""
            : String(candidate.provider.tidalTrackId),
        candidate.provider.tidalTrackId === null
            ? ""
            : `tidal:${candidate.provider.tidalTrackId}`,
    ];
    return identities.some((identity) => identity && excludes.has(identity));
}

function baselineRank(
    candidates: readonly RecommendationCandidate[],
    excludes: ReadonlySet<string>,
    limit: number,
    perLaneLimit?: number,
): ScoredRecommendation[] {
    const seenCanonical = new Set<string>();
    const recommendations: ScoredRecommendation[] = [];
    const laneCounts = new Map<
        NonNullable<RecommendationCandidate["lane"]>,
        number
    >();
    const normalizedPerLaneLimit =
        perLaneLimit !== undefined && Number.isFinite(perLaneLimit)
            ? Math.max(0, Math.floor(perLaneLimit))
            : null;
    for (const candidate of candidates) {
        if (
            !hasPlayableIdentity(candidate) ||
            isExcluded(candidate, excludes)
        ) {
            continue;
        }
        if (seenCanonical.has(candidate.canonicalKey)) continue;
        if (
            candidate.lane &&
            normalizedPerLaneLimit !== null &&
            (laneCounts.get(candidate.lane) ?? 0) >= normalizedPerLaneLimit
        ) {
            continue;
        }
        seenCanonical.add(candidate.canonicalKey);
        recommendations.push({
            track: candidate,
            score: candidate.providerPrior,
        });
        if (candidate.lane) {
            laneCounts.set(
                candidate.lane,
                (laneCounts.get(candidate.lane) ?? 0) + 1,
            );
        }
        if (recommendations.length >= limit) break;
    }
    return recommendations;
}

function superviseBackground(
    operation: string,
    context: Record<string, unknown>,
    run: () => Promise<unknown>,
): void {
    try {
        void run().catch((error: unknown) => {
            recommendationLogger.warn(`${operation} failed`, {
                ...context,
                error,
            });
        });
    } catch (error) {
        recommendationLogger.warn(`${operation} failed`, {
            ...context,
            error,
        });
    }
}

/**
 * One recommendation policy boundary shared by Home, Wave, Made For You and
 * Similar Tracks. Candidate adapters stay outside; identity, account history,
 * ranking, experiment semantics and exposure persistence stay inside.
 */
export class RecommendationEngine {
    constructor(
        private readonly dependencies: RecommendationEngineDependencies,
        private readonly metrics: RecommendationEngineMetricsRecorder = defaultMetricsRecorder,
    ) {}

    async recommend(request: RecommendRequest): Promise<RecommendResult> {
        const startedAt = this.dependencies.now();
        const cursor = request.cursor ?? 0;
        const limit = Math.max(0, Math.floor(request.limit));
        const loaded = await this.dependencies.loadCandidates(request);
        const degradedSources = [...new Set(loaded.degradedSources)];
        let candidates = await this.resolveCanonicalCandidates(
            loaded.candidates,
            degradedSources,
        );
        if (this.dependencies.enrichCandidates && candidates.length > 0) {
            try {
                candidates =
                    await this.dependencies.enrichCandidates(candidates);
            } catch (error) {
                appendDegradedSource(degradedSources, "canonical-features");
                recommendationLogger.warn(
                    "canonical feature enrichment failed",
                    { userId: request.userId },
                    error,
                );
            }
        }
        const excludes = new Set(
            (request.exclude ?? [])
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
        );
        const baseline = baselineRank(
            candidates,
            excludes,
            limit,
            request.perLaneLimit,
        );

        if (this.dependencies.mode === "baseline") {
            const generationId = await this.recordGeneration({
                request,
                cursor,
                algorithm: "baseline-v1",
                served: true,
                degradedSources,
                recommendations: baseline,
                startedAt,
            });
            this.scheduleHotSet(request, baseline);
            return {
                tracks: baseline.map(({ track }) => track),
                nextCursor: loaded.nextCursor,
                generationId,
                degradedSources,
            };
        }

        const hybridContext = await this.loadHybridContext(request, startedAt);
        for (const source of hybridContext.degradedSources) {
            appendDegradedSource(degradedSources, source);
        }
        const hybrid = rankRecommendationCandidates(
            candidates.filter((candidate) => !isExcluded(candidate, excludes)),
            {
                now: startedAt,
                limit,
                perLaneLimit: request.perLaneLimit,
                sessionId: request.sessionId,
                direction: request.intent.direction,
                mood: request.intent.mood ?? null,
                dislikedCanonicalKeys: hybridContext.dislikedCanonicalKeys,
                exposures: hybridContext.exposures,
                positiveCentroids: hybridContext.taste.positiveCentroids,
                negativeCentroids: hybridContext.taste.negativeCentroids,
                sessionPositiveEmbedding:
                    hybridContext.taste.sessionPositiveEmbedding,
                sessionNegativeEmbedding:
                    hybridContext.taste.sessionNegativeEmbedding,
                contextCentroids: hybridContext.taste.contextCentroids,
                moodEmbedding: hybridContext.taste.moodEmbedding,
                explorationRate: this.dependencies.explorationRate,
            },
        );

        if (this.dependencies.mode === "shadow") {
            const generationId = await this.recordGeneration({
                request,
                cursor,
                algorithm: "baseline-v1",
                served: true,
                degradedSources,
                recommendations: baseline,
                startedAt,
            });
            superviseBackground(
                "shadow generation persistence",
                { userId: request.userId, sessionId: request.sessionId },
                () =>
                    this.recordGeneration({
                        request,
                        cursor,
                        algorithm: "hybrid-v2",
                        served: false,
                        degradedSources,
                        recommendations: hybrid,
                        startedAt,
                    }),
            );
            this.scheduleHotSet(request, hybrid);
            return {
                tracks: baseline.map(({ track }) => track),
                nextCursor: loaded.nextCursor,
                generationId,
                degradedSources,
            };
        }

        const normalizedRolloutPercent = Math.max(
            0,
            Math.min(100, this.dependencies.hybridRolloutPercent),
        );
        const servesHybrid =
            rolloutBucket(request.userId, request.sessionId) * 100 <
            normalizedRolloutPercent;
        const servedAlgorithm = servesHybrid ? "hybrid-v2" : "baseline-v1";
        const servedRecommendations = servesHybrid ? hybrid : baseline;
        const generationId = await this.recordGeneration({
            request,
            cursor,
            algorithm: servedAlgorithm,
            served: true,
            experimentAssignment: "session-switchback-v1",
            degradedSources,
            recommendations: servedRecommendations,
            startedAt,
        });
        if (normalizedRolloutPercent < 100) {
            superviseBackground(
                "paired rollout generation persistence",
                { userId: request.userId, sessionId: request.sessionId },
                () =>
                    this.recordGeneration({
                        request,
                        cursor,
                        algorithm: servesHybrid ? "baseline-v1" : "hybrid-v2",
                        served: false,
                        experimentAssignment: "session-switchback-v1",
                        degradedSources,
                        recommendations: servesHybrid ? baseline : hybrid,
                        startedAt,
                    }),
            );
        }
        this.scheduleHotSet(request, hybrid);
        return {
            tracks: servedRecommendations.map(({ track }) => track),
            nextCursor: loaded.nextCursor,
            generationId,
            degradedSources,
        };
    }

    private async resolveCanonicalCandidates(
        candidates: readonly RecommendationCandidate[],
        degradedSources: string[],
    ): Promise<RecommendationCandidate[]> {
        const resolved: RecommendationCandidate[] = [];
        for (
            let offset = 0;
            offset < candidates.length;
            offset += CANONICAL_RESOLUTION_BATCH_SIZE
        ) {
            const batch = candidates.slice(
                offset,
                offset + CANONICAL_RESOLUTION_BATCH_SIZE,
            );
            const identities = await Promise.allSettled(
                batch.map((candidate) =>
                    this.dependencies.resolveCanonical(candidate),
                ),
            );
            identities.forEach((identity, index) => {
                const candidate = batch[index];
                if (identity.status === "fulfilled") {
                    resolved.push({
                        ...candidate,
                        canonicalRecordingId: identity.value.id,
                        canonicalKey: identity.value.canonicalKey,
                    });
                    return;
                }
                appendDegradedSource(degradedSources, "canonical-identity");
                recommendationLogger.warn("canonical resolution failed", {
                    candidateId: candidate.id,
                    error: identity.reason,
                });
                resolved.push(candidate);
            });
        }
        return resolved;
    }

    private async loadHybridContext(
        request: RecommendRequest,
        now: Date,
    ): Promise<HybridContext> {
        const [exposures, dislikes, taste] = await Promise.allSettled([
            this.dependencies.loadRecentExposures(request.userId, now),
            this.dependencies.loadDislikedCanonicalKeys(request.userId),
            this.dependencies.loadTasteContext(request.userId, request),
        ]);
        const degradedSources: string[] = [];
        if (exposures.status === "rejected") {
            appendDegradedSource(degradedSources, "exposure-history");
        }
        if (dislikes.status === "rejected") {
            appendDegradedSource(degradedSources, "taste-dislikes");
        }
        if (taste.status === "rejected") {
            appendDegradedSource(degradedSources, "taste-profile");
        } else {
            for (const source of taste.value.degradedSources ?? []) {
                appendDegradedSource(degradedSources, source);
            }
        }
        return {
            exposures: exposures.status === "fulfilled" ? exposures.value : [],
            dislikedCanonicalKeys:
                dislikes.status === "fulfilled" ? dislikes.value : new Set(),
            taste:
                taste.status === "fulfilled"
                    ? taste.value
                    : { positiveCentroids: [], negativeCentroids: [] },
            degradedSources,
        };
    }

    private async recordGeneration(input: {
        request: RecommendRequest;
        cursor: number;
        algorithm: RecordEngineGenerationInput["algorithm"];
        served: boolean;
        experimentAssignment?: "session-switchback-v1";
        degradedSources: string[];
        recommendations: ScoredRecommendation[];
        startedAt: Date;
    }): Promise<string> {
        const latencyMs = Math.max(
            0,
            this.dependencies.now().getTime() - input.startedAt.getTime(),
        );
        const generationId = await this.dependencies.recordGeneration({
            userId: input.request.userId,
            sessionId: input.request.sessionId,
            surface: input.request.intent.surface,
            direction: input.request.intent.direction,
            mood: input.request.intent.mood ?? null,
            cursor: input.cursor,
            algorithm: input.algorithm,
            served: input.served,
            degradedSources: [...input.degradedSources],
            latencyMs,
            context: {
                ...requestContext(input.request),
                ...(input.experimentAssignment
                    ? { experimentAssignment: input.experimentAssignment }
                    : {}),
            },
            recommendations: input.recommendations,
        });
        try {
            this.metrics.recordGeneration({
                surface: input.request.intent.surface,
                algorithm: input.algorithm,
                served: input.served,
                latencyMs,
                degradedSourceCount: input.degradedSources.length,
            });
        } catch (error) {
            recommendationLogger.warn("generation telemetry failed", {
                surface: input.request.intent.surface,
                algorithm: input.algorithm,
                error,
            });
        }
        return generationId;
    }

    private scheduleHotSet(
        request: RecommendRequest,
        recommendations: readonly ScoredRecommendation[],
    ): void {
        if (recommendations.length === 0) return;
        superviseBackground(
            "hot-set scheduling",
            { userId: request.userId, sessionId: request.sessionId },
            () =>
                this.dependencies.scheduleHotSet({
                    userId: request.userId,
                    sessionId: request.sessionId,
                    surface: request.intent.surface,
                    candidates: recommendations.map(({ track }) => track),
                }),
        );
    }
}
