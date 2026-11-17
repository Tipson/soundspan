/** Closed source vocabulary exposed by the private recommendation trace reader. */
export type RecommendationTraceSource =
    | "youtube"
    | "tidal"
    | "library"
    | "vk"
    | "yandex";
/** Version 1 signed ranker contribution names. */
export type RecommendationTracePartName =
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
/** Bounded numerical score diagnostics; unavailable measurements remain null. */
export interface RecommendationScoreTraceV1 {
    version: 1;
    policy: "baseline-v1" | "hybrid-v2";
    baseScore: number | null;
    parts: {
        name: RecommendationTracePartName;
        state: "known" | "absent" | "unused";
        value: number | null;
    }[];
    selection: {
        method: "mmr" | "exploration" | "baseline";
        score: number | null;
        diversityPenalty: number | null;
        cooldown: "fresh" | "backfill" | null;
    };
}
/** Guard evaluations and selection events, rather than uniquely excluded recordings. */
export type RecommendationTraceCounter =
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
/** Privacy-limited persisted diagnostics, independent of raw generation context. */
export interface RecommendationGenerationTraceV1 {
    version: 1;
    policyVersion: "rank-trace-v1";
    algorithm: "baseline-v1" | "hybrid-v2";
    mode: "baseline" | "shadow" | "active";
    served: boolean;
    assignment: "session-switchback-v1" | null;
    requestedCount: number;
    returnedCount: number;
    shortfallCount: number;
    coverage: {
        loadedCount: number;
        sanitizedCount: number;
        canonicalIdPresentCount: number;
        embeddingPresentCount: number;
        admittedCount: number;
        rankInputCount: number;
        loadedSources: Record<RecommendationTraceSource, number>;
    };
    filters: {
        invalidNative: number;
        contentExcluded: number;
        moodExcluded: number;
        disliked: number;
        feedbackUnavailable: number;
    };
    ranker?: {
        version: 1;
        policy: "hybrid-v2";
        inputCount: number;
        counters: Partial<Record<RecommendationTraceCounter, number>>;
    };
    spacing: {
        applied: boolean;
        scope: "page" | "captured-prefix";
        observedRows: number;
        movedOccurrences: number;
        knownArtists: number;
        unknownArtistRows: number;
        adjacentKnownArtistPairs: number;
        minimumKnownArtistGap: number | null;
    };
    items: {
        position: number;
        rankPosition: number | null;
        source: RecommendationTraceSource;
        score: number | null;
        scoring: RecommendationScoreTraceV1 | null;
    }[];
    truncated: boolean;
}
/** Exact mirror of the interactive-admin single-generation reader response. */
export type AdminRecommendationTraceResponse =
    | { available: false; generationId: string }
    | {
          available: true;
          generationId: string;
          createdAt: string;
          surface: "wave" | "home" | "made-for-you" | "similar-tracks";
          algorithm: "baseline-v1" | "hybrid-v2";
          served: boolean;
          trace: RecommendationGenerationTraceV1;
          exposures: {
              position: number;
              source: RecommendationTraceSource | null;
              providerTrackId: string | null;
              score: number | null;
          }[];
      };

/** Reader identity is exact ASCII; whitespace, arrays and URLs carry no authority. */
export function isRecommendationTraceId(value: string): boolean {
    return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
