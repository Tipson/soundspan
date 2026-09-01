import { prisma } from "../../utils/db";

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

export interface RecommendationShadowEvaluationWindow {
    since: Date;
    until: Date;
}

export interface RecommendationEvaluationExposureSample {
    canonicalKey: string;
    artistKey: string;
    exposedAt: Date;
    playedAt: Date | null;
    listenedSeconds: number | null;
    completionRatio: number | null;
    outcome: string | null;
}

export interface RecommendationEvaluationGenerationSample {
    id: string;
    userId: string;
    sessionId: string;
    surface: string;
    direction: string;
    mood: string | null;
    cursor: number;
    algorithm: string;
    served: boolean;
    latencyMs: number;
    createdAt: Date;
    exposures: RecommendationEvaluationExposureSample[];
}

export interface RecommendationShadowEvaluationRepository {
    loadGenerations(
        since: Date,
        until: Date,
    ): Promise<RecommendationEvaluationGenerationSample[]>;
}

export interface RecommendationEngagementEvaluation {
    exposureCount: number;
    attributedCount: number;
    playbackRate: number;
    completionRate: number;
    earlySkipRate: number;
    meanCompletionRatio: number | null;
}

export interface RecommendationAlgorithmEvaluation {
    generationCount: number;
    servedGenerationCount: number;
    shadowGenerationCount: number;
    coverageRate: number;
    meanExposureCount: number;
    engagement: RecommendationEngagementEvaluation | null;
    playability: RecommendationPlayabilityEvaluation | null;
    repeats: RecommendationRepeatEvaluation;
    artists: RecommendationArtistEvaluation;
    latency: RecommendationLatencyEvaluation;
}

export interface RecommendationLatencyEvaluation {
    sampleCount: number;
    meanMs: number;
    p95Ms: number;
}

export interface RecommendationPlayabilityEvaluation {
    attemptedCount: number;
    playableCount: number;
    failureCount: number;
    playableHitRate: number;
    failureRate: number;
    meaningfulCompletionCount: number;
    meaningfulCompletionRate: number;
    earlySkipCount: number;
    earlySkipRate: number;
}

export interface RecommendationRepeatEvaluation {
    exposureCount: number;
    repeatOneDayCount: number;
    repeatOneDayRate: number;
    repeatSevenDayCount: number;
    repeatSevenDayRate: number;
}

export interface RecommendationArtistEvaluation {
    coveredExposureCount: number;
    uniqueArtistCount: number;
    artistCoverageRate: number;
    artistDiversityRate: number;
}

export interface RecommendationShadowEvaluationReport {
    window: RecommendationShadowEvaluationWindow;
    algorithms: {
        baseline: RecommendationAlgorithmEvaluation;
        hybrid: RecommendationAlgorithmEvaluation;
    };
    pairedShadow: {
        pairCount: number;
        meanJaccardOverlap: number;
        meanBaselineCoverage: number;
    };
}

function mean(values: readonly number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function latencyEvaluation(
    generations: readonly RecommendationEvaluationGenerationSample[],
): RecommendationLatencyEvaluation {
    const values = generations
        .map((generation) => generation.latencyMs)
        .filter((value) => Number.isFinite(value) && value >= 0)
        .sort((left, right) => left - right);
    if (values.length === 0) {
        return { sampleCount: 0, meanMs: 0, p95Ms: 0 };
    }
    const p95Index = Math.max(0, Math.ceil(values.length * 0.95) - 1);
    return {
        sampleCount: values.length,
        meanMs: mean(values),
        p95Ms: values[p95Index],
    };
}

function isAttributed(
    exposure: RecommendationEvaluationExposureSample,
): boolean {
    return Boolean(
        exposure.playedAt ||
        exposure.outcome ||
        exposure.completionRatio !== null ||
        typeof exposure.listenedSeconds === "number",
    );
}

function isCompleted(
    exposure: RecommendationEvaluationExposureSample,
): boolean {
    return (
        exposure.outcome === "completed" ||
        (exposure.completionRatio ?? 0) >= 0.85
    );
}

function isEarlySkip(
    exposure: RecommendationEvaluationExposureSample,
): boolean {
    if (exposure.outcome !== "skipped") return false;
    return (
        (exposure.completionRatio ?? 0) <= 0.2 ||
        (typeof exposure.listenedSeconds === "number" &&
            exposure.listenedSeconds < 30)
    );
}

function isFinalAttempt(
    exposure: RecommendationEvaluationExposureSample,
): boolean {
    return (
        exposure.outcome === "meaningful" ||
        exposure.outcome === "completed" ||
        exposure.outcome === "skipped" ||
        exposure.outcome === "failed"
    );
}

function isMeaningfulCompletion(
    exposure: RecommendationEvaluationExposureSample,
): boolean {
    return (
        exposure.outcome === "meaningful" || exposure.outcome === "completed"
    );
}

interface EvaluationExposureRow {
    generation: RecommendationEvaluationGenerationSample;
    exposure: RecommendationEvaluationExposureSample;
}

function exposureRows(
    generations: readonly RecommendationEvaluationGenerationSample[],
): EvaluationExposureRow[] {
    return generations.flatMap((generation) =>
        generation.exposures.map((exposure) => ({ generation, exposure })),
    );
}

function playabilityEvaluation(
    rows: readonly EvaluationExposureRow[],
): RecommendationPlayabilityEvaluation | null {
    const attempts = rows
        .filter(({ generation }) => generation.served)
        .map(({ exposure }) => exposure)
        .filter(isFinalAttempt);
    if (attempts.length === 0) return null;
    const failureCount = attempts.filter(
        (exposure) => exposure.outcome === "failed",
    ).length;
    const playableCount = attempts.length - failureCount;
    const meaningfulCompletionCount = attempts.filter(
        isMeaningfulCompletion,
    ).length;
    const earlySkipCount = attempts.filter(isEarlySkip).length;
    return {
        attemptedCount: attempts.length,
        playableCount,
        failureCount,
        playableHitRate: playableCount / attempts.length,
        failureRate: failureCount / attempts.length,
        meaningfulCompletionCount,
        meaningfulCompletionRate: meaningfulCompletionCount / attempts.length,
        earlySkipCount,
        earlySkipRate: earlySkipCount / attempts.length,
    };
}

function artistEvaluation(
    rows: readonly EvaluationExposureRow[],
): RecommendationArtistEvaluation {
    const covered = rows
        .map(({ exposure }) => exposure.artistKey?.trim() ?? "")
        .filter((artistKey) => artistKey.length > 0);
    return {
        coveredExposureCount: covered.length,
        uniqueArtistCount: new Set(covered).size,
        artistCoverageRate:
            rows.length === 0 ? 0 : covered.length / rows.length,
        artistDiversityRate:
            covered.length === 0 ? 0 : new Set(covered).size / covered.length,
    };
}

function exposureTimestamp(row: EvaluationExposureRow): number {
    return (
        row.exposure.exposedAt?.getTime() ?? row.generation.createdAt.getTime()
    );
}

function repeatEvaluation(
    rows: readonly EvaluationExposureRow[],
    allGenerations: readonly RecommendationEvaluationGenerationSample[],
): RecommendationRepeatEvaluation {
    const servedHistory = new Map<
        string,
        Array<{ exposedAt: number; generationId: string }>
    >();
    for (const row of exposureRows(
        allGenerations.filter((generation) => generation.served),
    )) {
        const key = `${row.generation.userId}\u0000${row.exposure.canonicalKey}`;
        const current = servedHistory.get(key) ?? [];
        current.push({
            exposedAt: exposureTimestamp(row),
            generationId: row.generation.id,
        });
        servedHistory.set(key, current);
    }

    let repeatOneDayCount = 0;
    let repeatSevenDayCount = 0;
    const pairedBaselineByGeneration = new Map<string, string | null>();
    for (const row of rows) {
        const key = `${row.generation.userId}\u0000${row.exposure.canonicalKey}`;
        const exposedAt = exposureTimestamp(row);
        if (!pairedBaselineByGeneration.has(row.generation.id)) {
            pairedBaselineByGeneration.set(
                row.generation.id,
                closestPairedBaselineId(row.generation, allGenerations),
            );
        }
        const pairedBaselineId =
            pairedBaselineByGeneration.get(row.generation.id) ?? null;
        const ages = (servedHistory.get(key) ?? [])
            .filter(
                (entry) =>
                    entry.generationId !== row.generation.id &&
                    entry.generationId !== pairedBaselineId &&
                    entry.exposedAt < exposedAt,
            )
            .map((entry) => exposedAt - entry.exposedAt);
        if (ages.some((age) => age <= ONE_DAY_MS)) repeatOneDayCount += 1;
        if (ages.some((age) => age <= SEVEN_DAYS_MS)) repeatSevenDayCount += 1;
    }
    return {
        exposureCount: rows.length,
        repeatOneDayCount,
        repeatOneDayRate:
            rows.length === 0 ? 0 : repeatOneDayCount / rows.length,
        repeatSevenDayCount,
        repeatSevenDayRate:
            rows.length === 0 ? 0 : repeatSevenDayCount / rows.length,
    };
}

function closestPairedBaselineId(
    generation: RecommendationEvaluationGenerationSample,
    allGenerations: readonly RecommendationEvaluationGenerationSample[],
): string | null {
    if (generation.algorithm !== "hybrid-v2" || generation.served) return null;
    const candidates = allGenerations
        .filter(
            (candidate) =>
                candidate.algorithm === "baseline-v1" &&
                candidate.served &&
                experimentKey(candidate) === experimentKey(generation),
        )
        .sort(
            (left, right) =>
                Math.abs(
                    left.createdAt.getTime() - generation.createdAt.getTime(),
                ) -
                Math.abs(
                    right.createdAt.getTime() - generation.createdAt.getTime(),
                ),
        );
    return candidates[0]?.id ?? null;
}

function aggregateAlgorithm(
    generations: readonly RecommendationEvaluationGenerationSample[],
    allGenerations: readonly RecommendationEvaluationGenerationSample[],
): RecommendationAlgorithmEvaluation {
    const exposureCounts = generations.map(
        (generation) => generation.exposures.length,
    );
    const servedExposures = generations
        .filter((generation) => generation.served)
        .flatMap((generation) => generation.exposures);
    const attributed = servedExposures.filter(isAttributed);
    const completionRatios = servedExposures.flatMap((exposure) =>
        exposure.completionRatio === null ? [] : [exposure.completionRatio],
    );
    const engagement =
        servedExposures.length === 0
            ? null
            : {
                  exposureCount: servedExposures.length,
                  attributedCount: attributed.length,
                  playbackRate: attributed.length / servedExposures.length,
                  completionRate:
                      attributed.length === 0
                          ? 0
                          : attributed.filter(isCompleted).length /
                            attributed.length,
                  earlySkipRate:
                      attributed.length === 0
                          ? 0
                          : attributed.filter(isEarlySkip).length /
                            attributed.length,
                  meanCompletionRatio:
                      completionRatios.length === 0
                          ? null
                          : mean(completionRatios),
              };
    const rows = exposureRows(generations);
    return {
        generationCount: generations.length,
        servedGenerationCount: generations.filter(
            (generation) => generation.served,
        ).length,
        shadowGenerationCount: generations.filter(
            (generation) => !generation.served,
        ).length,
        coverageRate:
            generations.length === 0
                ? 0
                : exposureCounts.filter((count) => count > 0).length /
                  generations.length,
        meanExposureCount: mean(exposureCounts),
        engagement,
        playability: playabilityEvaluation(rows),
        repeats: repeatEvaluation(rows, allGenerations),
        artists: artistEvaluation(rows),
        latency: latencyEvaluation(generations),
    };
}

function experimentKey(
    generation: RecommendationEvaluationGenerationSample,
): string {
    return [
        generation.userId,
        generation.sessionId,
        generation.surface,
        generation.direction,
        generation.mood ?? "",
        String(generation.cursor),
    ].join("\u0000");
}

function uniqueCanonicalKeys(
    generation: RecommendationEvaluationGenerationSample,
): Set<string> {
    return new Set(
        generation.exposures.map((exposure) => exposure.canonicalKey),
    );
}

function intersectionSize(
    left: ReadonlySet<string>,
    right: ReadonlySet<string>,
): number {
    let count = 0;
    for (const value of left) {
        if (right.has(value)) count += 1;
    }
    return count;
}

function evaluatePairs(
    baseline: readonly RecommendationEvaluationGenerationSample[],
    hybrid: readonly RecommendationEvaluationGenerationSample[],
): RecommendationShadowEvaluationReport["pairedShadow"] {
    const baselineByExperiment = new Map<
        string,
        RecommendationEvaluationGenerationSample[]
    >();
    for (const generation of baseline.filter((item) => item.served)) {
        const key = experimentKey(generation);
        const current = baselineByExperiment.get(key) ?? [];
        current.push(generation);
        baselineByExperiment.set(key, current);
    }
    const usedBaselineIds = new Set<string>();
    const jaccardValues: number[] = [];
    const baselineCoverageValues: number[] = [];
    for (const shadow of hybrid.filter((item) => !item.served)) {
        const matches = (baselineByExperiment.get(experimentKey(shadow)) ?? [])
            .filter((item) => !usedBaselineIds.has(item.id))
            .sort(
                (left, right) =>
                    Math.abs(
                        left.createdAt.getTime() - shadow.createdAt.getTime(),
                    ) -
                    Math.abs(
                        right.createdAt.getTime() - shadow.createdAt.getTime(),
                    ),
            );
        const served = matches[0];
        if (!served) continue;
        usedBaselineIds.add(served.id);
        const baselineKeys = uniqueCanonicalKeys(served);
        const hybridKeys = uniqueCanonicalKeys(shadow);
        const intersection = intersectionSize(baselineKeys, hybridKeys);
        const union = new Set([...baselineKeys, ...hybridKeys]).size;
        jaccardValues.push(union === 0 ? 0 : intersection / union);
        baselineCoverageValues.push(
            baselineKeys.size === 0 ? 0 : intersection / baselineKeys.size,
        );
    }
    return {
        pairCount: jaccardValues.length,
        meanJaccardOverlap: mean(jaccardValues),
        meanBaselineCoverage: mean(baselineCoverageValues),
    };
}

/**
 * Read-only evaluator for baseline-v1 versus hybrid-v2 generations. It reports
 * quality evidence but never changes the configured recommendation mode.
 */
export class RecommendationShadowEvaluationService {
    constructor(
        private readonly repository: RecommendationShadowEvaluationRepository,
    ) {}

    async evaluate(
        window: RecommendationShadowEvaluationWindow,
    ): Promise<RecommendationShadowEvaluationReport> {
        if (
            !Number.isFinite(window.since.getTime()) ||
            !Number.isFinite(window.until.getTime()) ||
            window.since >= window.until
        ) {
            throw new RangeError("Recommendation evaluation window is invalid");
        }
        const generations = await this.repository.loadGenerations(
            new Date(window.since.getTime() - SEVEN_DAYS_MS),
            window.until,
        );
        const reportGenerations = generations.filter(
            (generation) =>
                generation.createdAt >= window.since &&
                generation.createdAt < window.until,
        );
        const baseline = reportGenerations.filter(
            (generation) => generation.algorithm === "baseline-v1",
        );
        const hybrid = reportGenerations.filter(
            (generation) => generation.algorithm === "hybrid-v2",
        );
        return {
            window: { since: window.since, until: window.until },
            algorithms: {
                baseline: aggregateAlgorithm(baseline, generations),
                hybrid: aggregateAlgorithm(hybrid, generations),
            },
            pairedShadow: evaluatePairs(baseline, hybrid),
        };
    }
}

export const recommendationShadowEvaluation =
    new RecommendationShadowEvaluationService({
        loadGenerations: (since, until) =>
            prisma.recommendationGeneration.findMany({
                where: { createdAt: { gte: since, lt: until } },
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    userId: true,
                    sessionId: true,
                    surface: true,
                    direction: true,
                    mood: true,
                    cursor: true,
                    algorithm: true,
                    served: true,
                    latencyMs: true,
                    createdAt: true,
                    exposures: {
                        select: {
                            canonicalKey: true,
                            artistKey: true,
                            exposedAt: true,
                            playedAt: true,
                            listenedSeconds: true,
                            completionRatio: true,
                            outcome: true,
                        },
                    },
                },
            }),
    });
