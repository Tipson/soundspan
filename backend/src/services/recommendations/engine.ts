import { createHash } from "node:crypto";
import { logger } from "../../utils/logger";
import { recordRecommendationGenerationMetrics } from "../../metrics";
import type { RecommendationGenerationMetricInput } from "../../metrics/recommendationMetrics";
import {
    moodRankingScore,
    rankRecommendationCandidates,
    recommendationNegativeFeedbackPenalty,
} from "./rankerV2";
import { normalizeRecommendationArtistKey } from "./identityKeys";
import type { RadioRequestExecution } from "./radioRequestExecution";
import type { CurrentDislikeAdmission } from "./featureStore";
import type { VerifiedSourceRepeatExclusions } from "./verifiedSourceRepeats";
import {
    hasNativeRecommendationIdentity,
    readNativeRecommendationRecording,
    toNativeRecommendationCandidate,
} from "./nativeCandidates";
import {
    isWaveMusicCandidate,
    matchesWaveMood,
    needsWaveMoodAnalysis,
} from "./wavePolicy";
import type {
    RecommendRequest,
    RecommendResult,
    RecommendationCandidate,
    RecommendationExposureSignal,
    ScoredRecommendation,
} from "./types";

const CANONICAL_RESOLUTION_BATCH_SIZE = 8;
// Matches the existing scheduler's total admission capacity, not a queue quota.
const MOOD_ANALYSIS_RESERVE_LIMIT = 48;
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
    /** Only persisted server evidence permits cross-provider negative feedback. */
    verifiedCanonicalKey?: string;
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
    /** Optional server-owned radio deadline for atomic exposure persistence. */
    execution?: RadioRequestExecution;
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
    unmeasuredCanonicalIds?: readonly string[];
}

export interface RecommendationEngineDependencies {
    mode: RecommendationEngineMode;
    hybridRolloutPercent: number;
    explorationRate: number;
    /** Server-owned Wave ordering before its single served exposure write; absent retains legacy order. */
    finalizeWaveRecommendations?: (
        recommendations: readonly ScoredRecommendation[],
    ) => readonly ScoredRecommendation[];
    loadCandidates: (
        request: RecommendRequest,
        policyTime: Date,
    ) => Promise<RecommendationCandidateBatch>;
    resolveCanonical: (
        candidate: RecommendationCandidate,
    ) => Promise<CanonicalRecommendationIdentity | null>;
    /** Request-local prefetch; null slots retain ordinary canonical resolution. */
    loadCanonicalMappings?: (
        candidates: readonly RecommendationCandidate[],
    ) => Promise<readonly (CanonicalRecommendationIdentity | null)[]>;
    enrichCandidates?: (
        candidates: RecommendationCandidate[],
    ) => Promise<RecommendationCandidate[]>;
    loadRecentExposures: (
        userId: string,
        now: Date,
    ) => Promise<RecommendationExposureSignal[]>;
    loadDislikedCanonicalKeys: (
        userId: string,
        candidates?: readonly RecommendationCandidate[],
    ) => Promise<ReadonlySet<string>>;
    /** Whole-profile current-pool admission; bounded availability is not negative taste. */
    loadDislikeAdmission?: (
        userId: string,
        candidates: readonly RecommendationCandidate[],
        check?: () => void,
    ) => Promise<CurrentDislikeAdmission>;
    /** Exact owned native history, without requiring embeddings or a matching session. */
    loadVerifiedRepeatExclusions?: (
        userId: string,
        now: Date,
        check?: () => void,
    ) => Promise<VerifiedSourceRepeatExclusions>;
    /** Saved originals for Discoveries, including another upload of the same recording. */
    loadSavedCanonicalKeys?: (
        userId: string,
        candidates: readonly RecommendationCandidate[],
    ) => Promise<ReadonlySet<string>>;
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
        ...(request.intent.language
            ? { language: request.intent.language }
            : {}),
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
    unavailableCanonicalKeys: ReadonlySet<string>;
    unavailableCandidateReferences?: ReadonlySet<string>;
    verifiedCanonicalKeys?: ReadonlyMap<string, string>;
    admissionUnavailable: boolean;
    taste: RecommendationTasteContext;
    degradedSources: string[];
}

function appendDegradedSource(target: string[], source: string): void {
    if (!target.includes(source)) target.push(source);
}

function hasPlayableIdentity(candidate: RecommendationCandidate): boolean {
    if (candidate.source === "vk" || candidate.source === "yandex")
        return readNativeRecommendationRecording(candidate) !== null;
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
    waveMood?: RecommendRequest["intent"]["mood"],
    diversify = false,
    waveTaste?: RecommendationTasteContext,
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
    const artistCounts = new Map<string, number>();
    const ordered = candidates.map((candidate, index) => ({
        candidate,
        index,
        score:
            candidate.providerPrior +
            (waveMood ? moodRankingScore(candidate, waveMood) : 0) -
            (waveTaste
                ? recommendationNegativeFeedbackPenalty(candidate, waveTaste)
                : 0),
    }));
    if (
        waveMood ||
        (waveTaste?.negativeCentroids.length ?? 0) > 0 ||
        waveTaste?.sessionNegativeEmbedding
    )
        ordered.sort(
            (left, right) =>
                right.score - left.score || left.index - right.index,
        );
    for (const { candidate, score } of ordered) {
        if (
            !hasPlayableIdentity(candidate) ||
            isExcluded(candidate, excludes)
        ) {
            continue;
        }
        if (seenCanonical.has(candidate.canonicalKey)) continue;
        const artist = normalizeRecommendationArtistKey(candidate.artist.name);
        if (diversify && artist && (artistCounts.get(artist) ?? 0) >= 2)
            continue;
        if (
            candidate.lane &&
            normalizedPerLaneLimit !== null &&
            (laneCounts.get(candidate.lane) ?? 0) >= normalizedPerLaneLimit
        ) {
            continue;
        }
        seenCanonical.add(candidate.canonicalKey);
        artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
        recommendations.push({
            track: candidate,
            score,
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
        const loaded = await this.dependencies.loadCandidates(
            request,
            startedAt,
        );
        const isWave = request.intent.surface === "wave";
        const degradedSources = [...new Set(loaded.degradedSources)];
        const sourceCandidates = loaded.candidates.flatMap((candidate) => {
            if (!hasNativeRecommendationIdentity(candidate)) return [candidate];
            const recording = readNativeRecommendationRecording(candidate);
            if (!recording) return [];
            // Provider metadata cannot assert an existing canonical FK or measured features.
            // Both may be added only by the request's strict mapping/feature-store reads.
            const fresh = toNativeRecommendationCandidate(
                recording,
                candidate.candidateSources.join("+"),
            )!;
            return [{ ...fresh, lane: candidate.lane ?? fresh.lane }];
        });
        const verifiedKeys = new Map<string, string>();
        let candidates = await this.resolveCanonicalCandidates(
            isWave
                ? sourceCandidates.filter(isWaveMusicCandidate)
                : sourceCandidates,
            degradedSources,
            verifiedKeys,
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
        const pendingMoodCandidates = isWave
            ? candidates.filter(
                  (candidate) =>
                      candidate.lane === "discovery" &&
                      candidate.canonicalRecordingId &&
                      candidate.provider.youtubeVideoId &&
                      needsWaveMoodAnalysis(candidate, request.intent.mood),
              )
            : [];
        // Apply eligibility before lane quotas and either ranker, so discovery
        // and familiar insertions cannot reintroduce an incompatible recording.
        if (isWave)
            candidates = candidates.filter((candidate) =>
                matchesWaveMood(candidate, request.intent.mood),
            );
        const excludes = new Set(
            (request.exclude ?? [])
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
        );
        // Safety/variety policy belongs to Wave itself, not only the hybrid
        // experiment arm. Never refill a short Wave with today's exposures.
        const sharedContext = await this.loadHybridContext(request, startedAt, [
            ...candidates,
            ...pendingMoodCandidates,
        ]);
        const dislikes = sharedContext.dislikedCanonicalKeys;
        const isDisliked = (candidate: RecommendationCandidate) => {
            if (sharedContext.admissionUnavailable) return true;
            if (
                sharedContext.unavailableCandidateReferences?.has(
                    `${candidate.source}:${candidate.id}`,
                )
            )
                return true;
            const verified = (
                sharedContext.verifiedCanonicalKeys ?? verifiedKeys
            ).get(`${candidate.source}:${candidate.id}`);
            if (
                verified &&
                sharedContext.unavailableCanonicalKeys.has(verified)
            )
                return true;
            return (
                (verified !== undefined && dislikes.has(verified)) ||
                [
                    candidate.id,
                    candidate.provider.youtubeVideoId
                        ? `yt:${candidate.provider.youtubeVideoId}`
                        : "",
                    candidate.provider.youtubeVideoId ?? "",
                    candidate.provider.tidalTrackId !== null
                        ? `tidal:${candidate.provider.tidalTrackId}`
                        : "",
                ].some((key) => key && dislikes.has(key))
            );
        };
        candidates = candidates.filter((candidate) => !isDisliked(candidate));
        if (sharedContext) {
            for (const source of sharedContext.degradedSources)
                appendDegradedSource(degradedSources, source);
            for (const exposure of isWave ? sharedContext.exposures : []) {
                if (
                    startedAt.getTime() - exposure.exposedAt.getTime() <
                    24 * 60 * 60 * 1_000
                ) {
                    excludes.add(exposure.canonicalKey);
                }
            }
        }
        if (
            request.intent.direction === "new" &&
            this.dependencies.loadSavedCanonicalKeys
        ) {
            try {
                const savedKeys =
                    await this.dependencies.loadSavedCanonicalKeys(
                        request.userId,
                        [...candidates, ...pendingMoodCandidates],
                    );
                for (const key of savedKeys) excludes.add(key);
            } catch (error) {
                appendDegradedSource(degradedSources, "saved-recordings");
                recommendationLogger.warn("Saved recording lookup failed", {
                    error,
                });
                candidates = [];
            }
        }
        if (
            request.intent.surface !== "home" &&
            this.dependencies.loadVerifiedRepeatExclusions
        ) {
            try {
                const repeat =
                    await this.dependencies.loadVerifiedRepeatExclusions(
                        request.userId,
                        startedAt,
                    );
                for (const id of repeat.hardIds) excludes.add(id);
                const eligible = candidates.filter(
                    (candidate) =>
                        hasPlayableIdentity(candidate) &&
                        !isExcluded(candidate, excludes),
                );
                const fresh = eligible.filter(
                    (candidate) => !isExcluded(candidate, repeat.ids),
                );
                // Preserve the catalog's empty-pool personal fallback, never last-day attempts.
                if (
                    fresh.length > 0 ||
                    eligible.length === 0 ||
                    request.intent.direction === "new" ||
                    request.intent.surface === "similar-tracks"
                ) {
                    for (const id of repeat.ids) excludes.add(id);
                }
            } catch {
                appendDegradedSource(
                    degradedSources,
                    "source-listening-history",
                );
                recommendationLogger.warn(
                    "Verified source listening history unavailable",
                );
            }
        }
        const analysisReserve =
            limit > 0 &&
            ![
                "canonical-identity",
                "canonical-features",
                "exposure-history",
                "taste-dislikes",
                "saved-recordings",
                "source-listening-history",
            ].some((source) => degradedSources.includes(source))
                ? baselineRank(
                      pendingMoodCandidates.filter(
                          (candidate) => !isDisliked(candidate),
                      ),
                      excludes,
                      MOOD_ANALYSIS_RESERVE_LIMIT,
                  )
                : [];
        const baseline = baselineRank(
            candidates,
            excludes,
            limit,
            request.perLaneLimit,
            isWave ? request.intent.mood : undefined,
            isWave,
            sharedContext?.taste,
        );

        if (this.dependencies.mode === "baseline") {
            const served = this.finalizeWave(request, baseline);
            const generationId = await this.recordGeneration({
                request,
                cursor,
                algorithm: "baseline-v1",
                served: true,
                degradedSources,
                recommendations: served,
                startedAt,
            });
            this.scheduleHotSet(request, served, analysisReserve);
            return {
                tracks: served.map(({ track }) => track),
                nextCursor: loaded.nextCursor,
                generationId,
                degradedSources,
            };
        }

        const hybridContext =
            sharedContext ?? (await this.loadHybridContext(request, startedAt));
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
                // Hard negatives were admitted above with exact/verified edge proof.
                dislikedCanonicalKeys: new Set(),
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
            const served = this.finalizeWave(request, baseline);
            const generationId = await this.recordGeneration({
                request,
                cursor,
                algorithm: "baseline-v1",
                served: true,
                degradedSources,
                recommendations: served,
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
            this.scheduleHotSet(request, hybrid, analysisReserve);
            return {
                tracks: served.map(({ track }) => track),
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
        const servedRecommendations = this.finalizeWave(
            request,
            servesHybrid ? hybrid : baseline,
        );
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
        this.scheduleHotSet(request, hybrid, analysisReserve);
        return {
            tracks: servedRecommendations.map(({ track }) => track),
            nextCursor: loaded.nextCursor,
            generationId,
            degradedSources,
        };
    }

    private finalizeWave(
        request: RecommendRequest,
        recommendations: ScoredRecommendation[],
    ): ScoredRecommendation[] {
        const finalize = this.dependencies.finalizeWaveRecommendations;
        if (request.intent.surface !== "wave" || !finalize)
            return recommendations;
        const length = recommendations.length;
        const remaining = new Map<ScoredRecommendation, number>();
        for (const row of recommendations)
            remaining.set(row, (remaining.get(row) ?? 0) + 1);
        const finalized = finalize(recommendations);
        if (!Array.isArray(finalized) || finalized.length !== length)
            throw new Error(
                "Wave finalization must retain admitted occurrences",
            );
        for (const row of finalized) {
            const count = remaining.get(row) ?? 0;
            if (count === 0)
                throw new Error(
                    "Wave finalization must retain admitted occurrences",
                );
            remaining.set(row, count - 1);
        }
        return [...finalized];
    }

    private async resolveCanonicalCandidates(
        candidates: readonly RecommendationCandidate[],
        degradedSources: string[],
        verifiedKeys: Map<string, string>,
    ): Promise<RecommendationCandidate[]> {
        const resolved: RecommendationCandidate[] = [];
        let mapped: readonly (CanonicalRecommendationIdentity | null)[] = [];
        if (this.dependencies.loadCanonicalMappings && candidates.length > 0) {
            try {
                mapped =
                    await this.dependencies.loadCanonicalMappings(candidates);
            } catch (error) {
                recommendationLogger.warn(
                    "Canonical batch lookup failed; resolving individually",
                    { error },
                );
            }
        }
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
                batch.map((candidate, index) =>
                    mapped[offset + index]
                        ? Promise.resolve(mapped[offset + index]!)
                        : this.dependencies.resolveCanonical(candidate),
                ),
            );
            identities.forEach((identity, index) => {
                const candidate = batch[index];
                if (identity.status === "fulfilled" && identity.value) {
                    if (
                        identity.value.verifiedCanonicalKey ===
                        identity.value.canonicalKey
                    ) {
                        verifiedKeys.set(
                            `${candidate.source}:${candidate.id}`,
                            identity.value.verifiedCanonicalKey,
                        );
                    }
                    resolved.push({
                        ...candidate,
                        canonicalRecordingId: identity.value.id,
                        canonicalKey: identity.value.canonicalKey,
                    });
                    return;
                }
                if (identity.status === "fulfilled") {
                    resolved.push(candidate);
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
        candidates?: readonly RecommendationCandidate[],
    ): Promise<HybridContext> {
        const admission: Promise<{
            dislikedKeys: ReadonlySet<string>;
            unavailableCanonicalKeys: ReadonlySet<string>;
            unavailableCandidateReferences?: ReadonlySet<string>;
            verifiedCanonicalKeys?: ReadonlyMap<string, string>;
            diagnostics?: { aliasLookupFailures?: number };
        }> =
            this.dependencies.loadDislikeAdmission && candidates
                ? this.dependencies.loadDislikeAdmission(
                      request.userId,
                      candidates,
                  )
                : this.dependencies
                      .loadDislikedCanonicalKeys(request.userId, candidates)
                      .then((keys) => ({
                          dislikedKeys: keys,
                          unavailableCanonicalKeys: new Set<string>(),
                      }));
        const [exposures, dislikes, taste] = await Promise.allSettled([
            this.dependencies.mode === "baseline" &&
            request.intent.surface !== "wave"
                ? Promise.resolve<RecommendationExposureSignal[]>([])
                : this.dependencies.loadRecentExposures(request.userId, now),
            admission,
            this.dependencies.mode === "baseline" &&
            request.intent.surface !== "wave"
                ? Promise.resolve<RecommendationTasteContext>({
                      positiveCentroids: [],
                      negativeCentroids: [],
                  })
                : this.dependencies.loadTasteContext(request.userId, request),
        ]);
        const degradedSources: string[] = [];
        if (exposures.status === "rejected") {
            appendDegradedSource(degradedSources, "exposure-history");
        }
        if (dislikes.status === "rejected") {
            appendDegradedSource(degradedSources, "taste-dislikes");
        } else if (
            dislikes.value.unavailableCanonicalKeys.size > 0 ||
            (dislikes.value.unavailableCandidateReferences?.size ?? 0) > 0 ||
            (dislikes.value.diagnostics?.aliasLookupFailures ?? 0) > 0
        ) {
            appendDegradedSource(degradedSources, "dislike-identity-coverage");
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
                dislikes.status === "fulfilled"
                    ? dislikes.value.dislikedKeys
                    : new Set(),
            unavailableCanonicalKeys:
                dislikes.status === "fulfilled"
                    ? dislikes.value.unavailableCanonicalKeys
                    : new Set(),
            verifiedCanonicalKeys:
                dislikes.status === "fulfilled"
                    ? dislikes.value.verifiedCanonicalKeys
                    : undefined,
            unavailableCandidateReferences:
                dislikes.status === "fulfilled"
                    ? dislikes.value.unavailableCandidateReferences
                    : undefined,
            admissionUnavailable:
                Boolean(this.dependencies.loadDislikeAdmission) &&
                dislikes.status === "rejected",
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
        analysisReserve: readonly ScoredRecommendation[] = [],
    ): void {
        if (recommendations.length === 0 && analysisReserve.length === 0)
            return;
        superviseBackground(
            "hot-set scheduling",
            { userId: request.userId, sessionId: request.sessionId },
            () =>
                this.dependencies.scheduleHotSet({
                    userId: request.userId,
                    sessionId: request.sessionId,
                    surface: request.intent.surface,
                    // Completed returned songs must not consume the fair input
                    // lane before its unknown, explicitly requested discoveries.
                    candidates: [...analysisReserve, ...recommendations].map(
                        ({ track }) => track,
                    ),
                    ...(analysisReserve.length > 0
                        ? {
                              unmeasuredCanonicalIds: analysisReserve.map(
                                  ({ track }) => track.canonicalRecordingId!,
                              ),
                          }
                        : {}),
                }),
        );
    }
}
