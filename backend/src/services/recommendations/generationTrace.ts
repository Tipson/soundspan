import { z } from "zod";
import type { ScoredRecommendation } from "./types";
import type { RankTraceSummaryV1 } from "./scoreTrace";
import { normalizeRecommendationArtistKey } from "./identityKeys";

/** Explicit storage and reader limits; no raw candidate features are retained. */
export const GENERATION_TRACE_LIMITS = { rows: 75, bytes: 65_536 } as const;
const count = z.number().int().min(0).max(1_000_000);
const scalar = z.number().nullable();
const source = z.enum(["youtube", "tidal", "library", "vk", "yandex"]);
const partName = z.enum([
    "providerPrior",
    "accountAffinity",
    "moodFeatures",
    "positiveSimilarity",
    "negativeFeedback",
    "moodSimilarity",
    "sessionPositive",
    "contextSimilarity",
    "recentRecording",
    "recentArtist",
    "recentAlbum",
    "exploration",
]);
const scoring = z
    .object({
        version: z.literal(1),
        policy: z.enum(["baseline-v1", "hybrid-v2"]),
        baseScore: scalar,
        parts: z
            .array(
                z
                    .object({
                        name: partName,
                        state: z.enum(["known", "absent", "unused"]),
                        value: scalar,
                    })
                    .strict(),
            )
            .max(12),
        selection: z
            .object({
                method: z.enum(["mmr", "exploration", "baseline"]),
                score: scalar,
                diversityPenalty: scalar,
                cooldown: z.enum(["fresh", "backfill"]).nullable(),
            })
            .strict(),
    })
    .strict();
const ranker = z
    .object({
        version: z.literal(1),
        policy: z.literal("hybrid-v2"),
        inputCount: count,
        counters: z
            .object({
                input: count.optional(),
                invalidNative: count.optional(),
                disliked: count.optional(),
                missingIdentity: count.optional(),
                recentCooldown: count.optional(),
                duplicateCanonical: count.optional(),
                artistCap: count.optional(),
                albumCap: count.optional(),
                laneCap: count.optional(),
                explorationReplaced: count.optional(),
                freshSelected: count.optional(),
                backfillSelected: count.optional(),
            })
            .strict(),
    })
    .strict();
const coverage = z
    .object({
        loadedCount: count,
        sanitizedCount: count,
        canonicalIdPresentCount: count,
        embeddingPresentCount: count,
        admittedCount: count,
        rankInputCount: count,
        loadedSources: z
            .object({
                youtube: count,
                tidal: count,
                library: count,
                vk: count,
                yandex: count,
            })
            .strict(),
    })
    .strict();
const filters = z
    .object({
        invalidNative: count,
        contentExcluded: count,
        moodExcluded: count,
        disliked: count,
        feedbackUnavailable: count,
    })
    .strict();
const schema = z
    .object({
        version: z.literal(1),
        policyVersion: z.literal("rank-trace-v1"),
        algorithm: z.enum(["baseline-v1", "hybrid-v2"]),
        mode: z.enum(["baseline", "shadow", "active"]),
        served: z.boolean(),
        assignment: z.literal("session-switchback-v1").nullable(),
        requestedCount: count,
        returnedCount: count,
        shortfallCount: count,
        coverage,
        filters,
        ranker: ranker.optional(),
        spacing: z
            .object({
                applied: z.boolean(),
                scope: z.enum(["page", "captured-prefix"]),
                observedRows: count,
                movedOccurrences: count,
                knownArtists: count,
                unknownArtistRows: count,
                adjacentKnownArtistPairs: count,
                minimumKnownArtistGap: count.nullable(),
            })
            .strict(),
        items: z
            .array(
                z
                    .object({
                        position: z.number().int().min(0).max(2_147_483_647),
                        rankPosition: count.nullable(),
                        source,
                        score: scalar,
                        scoring: scoring.nullable(),
                    })
                    .strict(),
            )
            .max(GENERATION_TRACE_LIMITS.rows),
        truncated: z.boolean(),
    })
    .strict();

/** Privacy-limited persisted trace, read only through an authenticated admin scope. */
export type RecommendationGenerationTraceV1 = z.infer<typeof schema>;
/** Observed request-local coverage, never a claim of global catalogue analysis. */
export type GenerationTraceCoverageV1 = z.infer<typeof coverage>;
/** Distinct observed admission reasons; an unavailable check is not a dislike. */
export type GenerationTraceFiltersV1 = z.infer<typeof filters>;

/** Unknown versions, extra private data and oversized traces are unavailable. */
export function readRecommendationGenerationTrace(
    value: unknown,
): RecommendationGenerationTraceV1 | undefined {
    try {
        if (!value || typeof value !== "object" || Array.isArray(value))
            return undefined;
        const raw = value as Record<string, unknown>;
        if (
            raw.version !== 1 ||
            !Array.isArray(raw.items) ||
            raw.items.length > GENERATION_TRACE_LIMITS.rows
        )
            return undefined;
        for (const item of raw.items) {
            if (!item || typeof item !== "object" || Array.isArray(item))
                return undefined;
            const detail = (item as Record<string, unknown>).scoring;
            if (
                detail !== null &&
                detail !== undefined &&
                (typeof detail !== "object" ||
                    Array.isArray(detail) ||
                    !Array.isArray((detail as Record<string, unknown>).parts) ||
                    ((detail as Record<string, unknown>).parts as unknown[])
                        .length > 12)
            )
                return undefined;
        }
        const result = schema.safeParse(value);
        if (!result.success) return undefined;
        const trace = result.data;
        if (
            trace.items.length > trace.returnedCount ||
            trace.truncated !== trace.items.length < trace.returnedCount
        )
            return undefined;
        for (let index = 0; index < trace.items.length; index++) {
            const item = trace.items[index];
            if (item.position !== trace.items[0].position + index)
                return undefined;
            if (item.scoring) {
                if (
                    item.scoring.policy !== trace.algorithm ||
                    item.scoring.baseScore !== item.score
                )
                    return undefined;
                if (
                    new Set(item.scoring.parts.map((part) => part.name))
                        .size !== item.scoring.parts.length
                )
                    return undefined;
                if (
                    item.scoring.parts.some(
                        (part) =>
                            (part.state === "known") !== (part.value !== null),
                    )
                )
                    return undefined;
            }
        }
        return Buffer.byteLength(JSON.stringify(trace), "utf8") <=
            GENERATION_TRACE_LIMITS.bytes
            ? trace
            : undefined;
    } catch {
        return undefined;
    }
}

/** Capture actual final positions and ranker output without changing a queue or write. */
export function buildRecommendationGenerationTrace(input: {
    algorithm: "baseline-v1" | "hybrid-v2";
    mode: "baseline" | "shadow" | "active";
    served: boolean;
    assignment?: "session-switchback-v1";
    requestedCount: number;
    startPosition?: number;
    ranked: readonly ScoredRecommendation[];
    finalized: readonly ScoredRecommendation[];
    spacingApplied: boolean;
    coverage: GenerationTraceCoverageV1;
    filters: GenerationTraceFiltersV1;
    ranker?: RankTraceSummaryV1;
}): RecommendationGenerationTraceV1 | undefined {
    try {
        const indices = new Map<ScoredRecommendation, number[]>();
        input.ranked.forEach((row, i) => {
            const queue = indices.get(row) ?? [];
            queue.push(i);
            indices.set(row, queue);
        });
        const positions = new Map<ScoredRecommendation, number>();
        const artists = new Map<string, number>();
        let previous: string | null = null;
        let adjacent = 0;
        let unknown = 0;
        let minimumGap: number | null = null;
        let moved = 0;
        let itemBytes = 0;
        let prefixOpen = true;
        const items: RecommendationGenerationTraceV1["items"] = [];
        const observed = input.finalized.slice(0, GENERATION_TRACE_LIMITS.rows);
        observed.forEach((row, index) => {
            const occurrence = positions.get(row) ?? 0;
            positions.set(row, occurrence + 1);
            const rankPosition = indices.get(row)?.[occurrence] ?? null;
            if (rankPosition !== index) moved++;
            const normalized = normalizeRecommendationArtistKey(
                row.track.artist.name,
            );
            const artist =
                !normalized ||
                normalized === "unknown" ||
                normalized === "unknown artist"
                    ? null
                    : normalized;
            if (artist) {
                if (previous === artist) adjacent++;
                const last = artists.get(artist);
                if (last !== undefined)
                    minimumGap = Math.min(minimumGap ?? Infinity, index - last);
                artists.set(artist, index);
            } else unknown++;
            previous = artist;
            const detail = scoring.safeParse(row.scoreTrace);
            const item = {
                position: (input.startPosition ?? 0) + index,
                rankPosition,
                source: row.track.source,
                score: Number.isFinite(row.score) ? row.score : null,
                scoring:
                    detail.success && detail.data.policy === input.algorithm
                        ? detail.data
                        : null,
            };
            const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
            // Metadata has a fixed vocabulary and bounded counts; reserve its
            // worst-case envelope and keep only a contiguous item prefix.
            if (
                prefixOpen &&
                itemBytes + bytes <= GENERATION_TRACE_LIMITS.bytes - 4096
            ) {
                items.push(item);
                itemBytes += bytes;
            } else prefixOpen = false;
        });
        return readRecommendationGenerationTrace({
            version: 1,
            policyVersion: "rank-trace-v1",
            algorithm: input.algorithm,
            mode: input.mode,
            served: input.served,
            assignment: input.assignment ?? null,
            requestedCount: input.requestedCount,
            returnedCount: input.finalized.length,
            shortfallCount: Math.max(
                0,
                input.requestedCount - input.finalized.length,
            ),
            coverage: input.coverage,
            filters: input.filters,
            ...(input.ranker ? { ranker: input.ranker } : {}),
            spacing: {
                applied: input.spacingApplied,
                scope:
                    observed.length === input.finalized.length
                        ? "page"
                        : "captured-prefix",
                observedRows: observed.length,
                movedOccurrences: moved,
                knownArtists: artists.size,
                unknownArtistRows: unknown,
                adjacentKnownArtistPairs: adjacent,
                minimumKnownArtistGap: minimumGap,
            },
            items,
            truncated: input.finalized.length > items.length,
        });
    } catch {
        // Optional diagnostics must never prevent serving the already selected music.
        return undefined;
    }
}
