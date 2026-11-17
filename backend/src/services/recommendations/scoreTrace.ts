/** Fixed vocabulary for contributions captured by the version 1 ranker trace. */
export type RankScorePartNameV1 =
    | "providerPrior"
    | "accountAffinity"
    | "moodFeatures"
    | "positiveSimilarity"
    | "negativeFeedback"
    | "moodSimilarity"
    | "sessionPositive"
    | "contextSimilarity"
    | "recentRecording"
    | "recentArtist"
    | "recentAlbum"
    | "exploration";

/** Signed contribution; absent measurements and disabled terms never invent zero. */
export interface RankScorePartV1 {
    name: RankScorePartNameV1;
    state: "known" | "absent" | "unused";
    value: number | null;
}

/**
 * Versioned numerical diagnostics only, without candidate identity or raw features.
 * Finite scores retain their exact values; unavailable or nonfinite values are null.
 */
export interface RecommendationScoreTraceV1 {
    version: 1;
    policy: "baseline-v1" | "hybrid-v2";
    baseScore: number | null;
    parts: RankScorePartV1[];
    selection: {
        method: "mmr" | "exploration" | "baseline";
        score: number | null;
        diversityPenalty: number | null;
        cooldown: "fresh" | "backfill" | null;
    };
}

/** Guard evaluations and selection events, not uniquely excluded recordings. */
export type RankTraceCounter =
    | "input"
    | "invalidNative"
    | "disliked"
    | "missingIdentity"
    | "recentCooldown"
    | "duplicateCanonical"
    | "artistCap"
    | "albumCap"
    | "laneCap"
    | "explorationReplaced"
    | "freshSelected"
    | "backfillSelected";

/** Request-local hybrid ranker diagnostics; counts saturate at 1,000,000. */
export interface RankTraceSummaryV1 {
    version: 1;
    policy: "hybrid-v2";
    inputCount: number;
    counters: Partial<Record<RankTraceCounter, number>>;
}

/** Keep exact finite diagnostic values and represent nonfinite values as unavailable. */
export function boundedRankTraceNumber(value: number): number | null {
    return Number.isFinite(value) ? value : null;
}

/** Preserve a real measured zero, but never serialize an unavailable contribution. */
export function createRankScorePart(
    name: RankScorePartNameV1,
    value: number | null | undefined,
    state: RankScorePartV1["state"] = "known",
): RankScorePartV1 {
    const bounded =
        state === "known" && typeof value === "number"
            ? boundedRankTraceNumber(value)
            : null;
    return {
        name,
        state: state === "known" && bounded === null ? "absent" : state,
        value: bounded,
    };
}
