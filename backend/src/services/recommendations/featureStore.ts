import { prisma } from "../../utils/db";
import { parseEmbedding } from "../../utils/embedding";
import { buildTasteCentroids } from "./rankerV2";
import type { RecommendationCandidate } from "./types";
import type {
    RecommendationRequestContext,
    RecommendationSurface,
} from "./types";

const TASTE_LOOKBACK_DAYS = 180;
const MAX_TASTE_ROWS = 500;
const MAX_DISLIKES = 2_000;

export interface CanonicalFeatureRow {
    canonicalRecordingId: string;
    embedding: number[] | null;
    bpm: number | null;
    energy: number | null;
    valence: number | null;
    danceability: number | null;
    instrumentalness: number | null;
}

export interface RecommendationTasteRow {
    embedding: number[];
    outcome: string | null;
    completionRatio: number | null;
    listenedSeconds: number | null;
}

/** One recent session play resolved to its active canonical embedding. */
export interface RecommendationSessionRow extends RecommendationTasteRow {
    playedAt: Date;
}

interface RecommendationFeatureStoreDependencies {
    loadCanonicalFeatures: (
        canonicalRecordingIds: string[],
    ) => Promise<CanonicalFeatureRow[]>;
    loadTasteRows: (
        userId: string,
        since: Date,
    ) => Promise<RecommendationTasteRow[]>;
    loadDislikedCanonicalKeys: (userId: string) => Promise<string[]>;
    loadSeedCanonicalRecordingId: (seedId: string) => Promise<string | null>;
    loadSessionRows: (
        userId: string,
        sessionId: string,
        limit: number,
    ) => Promise<RecommendationSessionRow[]>;
    loadContextRows: (
        userId: string,
        surface: RecommendationSurface,
        context: RecommendationRequestContext,
        since: Date,
    ) => Promise<RecommendationTasteRow[]>;
    now: () => Date;
}

function tasteDelta(row: RecommendationTasteRow): number {
    if (row.outcome === "failed") return 0;
    if (
        row.outcome === "skipped" &&
        ((row.completionRatio ?? 0) <= 0.2 || (row.listenedSeconds ?? 0) < 30)
    ) {
        return -1;
    }
    if (row.outcome === "completed" || (row.completionRatio ?? 0) >= 0.85) {
        return 1;
    }
    if (row.outcome === "meaningful" || (row.listenedSeconds ?? 0) >= 240) {
        return 0.5;
    }
    return 0;
}

/** Shared, provider-neutral audio features plus account-scoped taste reads. */
export class RecommendationFeatureStore {
    constructor(
        private readonly dependencies: RecommendationFeatureStoreDependencies,
    ) {}

    async enrichCandidates(
        candidates: RecommendationCandidate[],
    ): Promise<RecommendationCandidate[]> {
        const canonicalRecordingIds = Array.from(
            new Set(
                candidates.flatMap((candidate) =>
                    candidate.canonicalRecordingId
                        ? [candidate.canonicalRecordingId]
                        : [],
                ),
            ),
        );
        if (canonicalRecordingIds.length === 0) return candidates;
        const rows = await this.dependencies.loadCanonicalFeatures(
            canonicalRecordingIds,
        );
        const byId = new Map(
            rows.map((row) => [row.canonicalRecordingId, row] as const),
        );
        return candidates.map((candidate) => {
            const row = candidate.canonicalRecordingId
                ? byId.get(candidate.canonicalRecordingId)
                : undefined;
            if (!row) return candidate;
            return {
                ...candidate,
                ...(row.embedding ? { embedding: row.embedding } : {}),
                audioFeatures: {
                    ...candidate.audioFeatures,
                    bpm: row.bpm,
                    energy: row.energy,
                    valence: row.valence,
                    danceability: row.danceability,
                    instrumentalness: row.instrumentalness,
                },
            };
        });
    }

    async loadTasteContext(
        userId: string,
        options?: {
            sessionId?: string;
            surface?: RecommendationSurface;
            context?: RecommendationRequestContext;
        },
    ): Promise<{
        positiveCentroids: number[][];
        negativeCentroids: number[][];
        sessionPositiveEmbedding: number[] | null;
        sessionNegativeEmbedding: number[] | null;
        sessionSignalCount: number;
        contextCentroids: number[][];
    }> {
        const since = new Date(
            this.dependencies.now().getTime() -
                TASTE_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000,
        );
        const [rows, sessionRows, contextRows] = await Promise.all([
            this.dependencies.loadTasteRows(userId, since),
            options?.sessionId
                ? this.dependencies.loadSessionRows(
                      userId,
                      options.sessionId,
                      30,
                  )
                : Promise.resolve([]),
            options?.surface && options.context
                ? this.dependencies.loadContextRows(
                      userId,
                      options.surface,
                      options.context,
                      since,
                  )
                : Promise.resolve([]),
        ]);
        const positive = rows
            .filter((row) => tasteDelta(row) > 0)
            .map((row) => row.embedding);
        const negative = rows
            .filter((row) => tasteDelta(row) < 0)
            .map((row) => row.embedding);
        return {
            positiveCentroids: buildTasteCentroids(positive, 5),
            negativeCentroids: buildTasteCentroids(negative, 3),
            sessionPositiveEmbedding: decayedSessionEmbedding(
                sessionRows,
                this.dependencies.now(),
                1,
            ),
            sessionNegativeEmbedding: decayedSessionEmbedding(
                sessionRows,
                this.dependencies.now(),
                -1,
            ),
            sessionSignalCount: sessionRows.length,
            contextCentroids: buildTasteCentroids(
                contextRows
                    .filter((row) => tasteDelta(row) > 0)
                    .map((row) => row.embedding),
                3,
            ),
        };
    }

    async loadDislikedCanonicalKeys(userId: string): Promise<Set<string>> {
        return new Set(
            await this.dependencies.loadDislikedCanonicalKeys(userId),
        );
    }

    async loadSeedEmbedding(seedId: string): Promise<number[] | null> {
        const canonicalRecordingId =
            await this.dependencies.loadSeedCanonicalRecordingId(seedId);
        if (!canonicalRecordingId) return null;
        const [row] = await this.dependencies.loadCanonicalFeatures([
            canonicalRecordingId,
        ]);
        return row?.embedding ?? null;
    }
}

const SESSION_HALF_LIFE_MS = 45 * 60 * 1_000;

function decayedSessionEmbedding(
    rows: RecommendationSessionRow[],
    now: Date,
    sign: 1 | -1,
): number[] | null {
    const eligible = rows.filter((row) => Math.sign(tasteDelta(row)) === sign);
    const dimension = eligible[0]?.embedding.length ?? 0;
    if (dimension === 0) return null;
    const sum = Array.from({ length: dimension }, () => 0);
    let weightSum = 0;
    for (const row of eligible) {
        if (row.embedding.length !== dimension) continue;
        const age = Math.max(0, now.getTime() - row.playedAt.getTime());
        const weight =
            Math.abs(tasteDelta(row)) *
            Math.pow(0.5, age / SESSION_HALF_LIFE_MS);
        row.embedding.forEach((value, index) => {
            sum[index] += value * weight;
        });
        weightSum += weight;
    }
    if (weightSum <= Number.EPSILON) return null;
    const mean = sum.map((value) => value / weightSum);
    const norm = Math.sqrt(
        mean.reduce((total, value) => total + value ** 2, 0),
    );
    return norm <= Number.EPSILON ? null : mean.map((value) => value / norm);
}

interface RawCanonicalFeatureRow {
    canonicalRecordingId: string;
    embedding: string | null;
    bpm: number | null;
    energy: number | null;
    valence: number | null;
    danceability: number | null;
    instrumentalness: number | null;
}

interface RawTasteRow {
    embedding: string;
    outcome: string | null;
    completionRatio: number | null;
    listenedSeconds: number | null;
}

function safelyParseVector(value: string | null): number[] | null {
    if (!value) return null;
    try {
        return parseEmbedding(value);
    } catch {
        return null;
    }
}

async function loadCanonicalFeatures(
    canonicalRecordingIds: string[],
): Promise<CanonicalFeatureRow[]> {
    if (canonicalRecordingIds.length === 0) return [];
    const rows = await prisma.$queryRaw<RawCanonicalFeatureRow[]>`
        SELECT
            cr.id AS "canonicalRecordingId",
            active_embedding.embedding,
            cr.bpm,
            cr.energy,
            cr.valence,
            cr.danceability,
            cr.instrumentalness
        FROM "CanonicalRecording" cr
        LEFT JOIN LATERAL (
            SELECT cre.embedding::text AS embedding
            FROM canonical_recording_embeddings cre
            JOIN embedding_spaces es ON es.id = cre.space_id
            WHERE cre.canonical_recording_id = cr.id
              AND es.status = 'active'
              AND es.cleaning_at IS NULL
            ORDER BY es.created_at DESC
            LIMIT 1
        ) active_embedding ON TRUE
        WHERE cr.id = ANY(${canonicalRecordingIds}::text[])
    `;
    return rows.map((row) => ({
        ...row,
        embedding: safelyParseVector(row.embedding),
    }));
}

async function loadTasteRows(
    userId: string,
    since: Date,
): Promise<RecommendationTasteRow[]> {
    const rows = await prisma.$queryRaw<RawTasteRow[]>`
        SELECT
            cre.embedding::text AS embedding,
            re.outcome,
            re."completionRatio",
            re."listenedSeconds"
        FROM "RecommendationExposure" re
        JOIN canonical_recording_embeddings cre
          ON cre.canonical_recording_id = re."canonicalRecordingId"
        JOIN embedding_spaces es ON es.id = cre.space_id
        WHERE re."userId" = ${userId}
          AND re."exposedAt" >= ${since}
          AND re."playedAt" IS NOT NULL
          AND es.status = 'active'
          AND es.cleaning_at IS NULL
        ORDER BY re."exposedAt" DESC
        LIMIT ${MAX_TASTE_ROWS}
    `;
    return rows.flatMap((row) => {
        const embedding = safelyParseVector(row.embedding);
        return embedding ? [{ ...row, embedding }] : [];
    });
}

async function loadSessionRows(
    userId: string,
    sessionId: string,
    limit: number,
): Promise<RecommendationSessionRow[]> {
    const boundedLimit = Math.max(1, Math.min(30, limit));
    const plays = await prisma.play.findMany({
        where: { userId, recommendationSessionId: sessionId },
        orderBy: { playedAt: "desc" },
        take: boundedLimit,
        select: {
            trackId: true,
            trackTidalId: true,
            trackYtMusicId: true,
            playedAt: true,
            outcome: true,
            completionRatio: true,
            listenedSeconds: true,
        },
    });
    if (plays.length === 0) return [];

    const localIds = plays.flatMap((play) =>
        play.trackId ? [play.trackId] : [],
    );
    const tidalIds = plays.flatMap((play) =>
        play.trackTidalId ? [play.trackTidalId] : [],
    );
    const youtubeIds = plays.flatMap((play) =>
        play.trackYtMusicId ? [play.trackYtMusicId] : [],
    );
    const mappings = await prisma.trackMapping.findMany({
        where: {
            stale: false,
            canonicalRecordingId: { not: null },
            OR: [
                ...(localIds.length > 0 ? [{ trackId: { in: localIds } }] : []),
                ...(tidalIds.length > 0
                    ? [{ trackTidalId: { in: tidalIds } }]
                    : []),
                ...(youtubeIds.length > 0
                    ? [{ trackYtMusicId: { in: youtubeIds } }]
                    : []),
            ],
        },
        select: {
            trackId: true,
            trackTidalId: true,
            trackYtMusicId: true,
            canonicalRecordingId: true,
        },
    });
    const canonicalByProvider = new Map<string, string>();
    for (const mapping of mappings) {
        if (!mapping.canonicalRecordingId) continue;
        if (mapping.trackId) {
            canonicalByProvider.set(
                `local:${mapping.trackId}`,
                mapping.canonicalRecordingId,
            );
        }
        if (mapping.trackTidalId) {
            canonicalByProvider.set(
                `tidal:${mapping.trackTidalId}`,
                mapping.canonicalRecordingId,
            );
        }
        if (mapping.trackYtMusicId) {
            canonicalByProvider.set(
                `youtube:${mapping.trackYtMusicId}`,
                mapping.canonicalRecordingId,
            );
        }
    }
    const canonicalIdForPlay = (play: (typeof plays)[number]) =>
        (play.trackId
            ? canonicalByProvider.get(`local:${play.trackId}`)
            : undefined) ??
        (play.trackTidalId
            ? canonicalByProvider.get(`tidal:${play.trackTidalId}`)
            : undefined) ??
        (play.trackYtMusicId
            ? canonicalByProvider.get(`youtube:${play.trackYtMusicId}`)
            : undefined);
    const canonicalIds = Array.from(
        new Set(plays.flatMap((play) => canonicalIdForPlay(play) ?? [])),
    );
    const featureByCanonical = new Map(
        (await loadCanonicalFeatures(canonicalIds)).flatMap((feature) =>
            feature.embedding
                ? [[feature.canonicalRecordingId, feature.embedding] as const]
                : [],
        ),
    );
    return plays.flatMap((play) => {
        const canonicalId = canonicalIdForPlay(play);
        const embedding = canonicalId
            ? featureByCanonical.get(canonicalId)
            : undefined;
        return embedding ? [{ ...play, embedding }] : [];
    });
}

function timeBucket(localHour: number | undefined): string | null {
    if (!Number.isInteger(localHour) || localHour === undefined) return null;
    if (localHour < 6) return "night";
    if (localHour < 12) return "morning";
    if (localHour < 18) return "afternoon";
    return "evening";
}

async function loadContextRows(
    userId: string,
    surface: RecommendationSurface,
    context: RecommendationRequestContext,
    since: Date,
): Promise<RecommendationTasteRow[]> {
    const bucket = timeBucket(context.localHour);
    const deviceClass = context.deviceClass ?? null;
    const rows = await prisma.$queryRaw<RawTasteRow[]>`
        SELECT
            cre.embedding::text AS embedding,
            re.outcome,
            re."completionRatio",
            re."listenedSeconds"
        FROM "RecommendationExposure" re
        JOIN "RecommendationGeneration" rg ON rg.id = re."generationId"
        JOIN canonical_recording_embeddings cre
          ON cre.canonical_recording_id = re."canonicalRecordingId"
        JOIN embedding_spaces es ON es.id = cre.space_id
        WHERE re."userId" = ${userId}
          AND re."playedAt" >= ${since}
          AND rg.surface = ${surface}
          AND (${deviceClass}::text IS NULL OR rg.context->>'deviceClass' = ${deviceClass})
          AND (${bucket}::text IS NULL OR rg.context->>'timeBucket' = ${bucket})
          AND es.status = 'active'
          AND es.cleaning_at IS NULL
        ORDER BY re."playedAt" DESC
        LIMIT 100
    `;
    return rows.flatMap((row) => {
        const embedding = safelyParseVector(row.embedding);
        return embedding ? [{ ...row, embedding }] : [];
    });
}

async function loadDislikedCanonicalKeys(userId: string): Promise<string[]> {
    const dislikes = await prisma.dislikedEntity.findMany({
        where: { userId, entityType: "track" },
        orderBy: { dislikedAt: "desc" },
        take: MAX_DISLIKES,
        select: { entityId: true },
    });
    if (dislikes.length === 0) return [];
    const localIds: string[] = [];
    const youtubeVideoIds: string[] = [];
    const tidalIds: number[] = [];
    for (const { entityId } of dislikes) {
        if (entityId.startsWith("yt:")) {
            youtubeVideoIds.push(entityId.slice(3));
        } else if (entityId.startsWith("tidal:")) {
            const tidalId = Number(entityId.slice(6));
            if (Number.isSafeInteger(tidalId) && tidalId > 0) {
                tidalIds.push(tidalId);
            }
        } else {
            localIds.push(entityId);
            youtubeVideoIds.push(entityId);
        }
    }
    const mappings = await prisma.trackMapping.findMany({
        where: {
            stale: false,
            canonicalRecordingId: { not: null },
            OR: [
                ...(localIds.length > 0 ? [{ trackId: { in: localIds } }] : []),
                ...(youtubeVideoIds.length > 0
                    ? [
                          {
                              trackYtMusic: {
                                  is: { videoId: { in: youtubeVideoIds } },
                              },
                          },
                      ]
                    : []),
                ...(tidalIds.length > 0
                    ? [
                          {
                              trackTidal: {
                                  is: { tidalId: { in: tidalIds } },
                              },
                          },
                      ]
                    : []),
            ],
        },
        select: {
            canonicalRecording: { select: { canonicalKey: true } },
        },
    });
    return mappings.flatMap((mapping) =>
        mapping.canonicalRecording?.canonicalKey
            ? [mapping.canonicalRecording.canonicalKey]
            : [],
    );
}

function providerSeedIdentity(seedId: string): {
    localId: string | null;
    youtubeVideoId: string | null;
    tidalId: number | null;
} {
    const trimmed = seedId.trim();
    for (const prefix of ["yt:", "related-yt-", "youtube:"]) {
        if (trimmed.startsWith(prefix)) {
            return {
                localId: null,
                youtubeVideoId: trimmed.slice(prefix.length) || null,
                tidalId: null,
            };
        }
    }
    if (trimmed.startsWith("tidal:")) {
        const tidalId = Number(trimmed.slice(6));
        return {
            localId: null,
            youtubeVideoId: null,
            tidalId:
                Number.isSafeInteger(tidalId) && tidalId > 0 ? tidalId : null,
        };
    }
    return {
        localId: trimmed || null,
        youtubeVideoId: trimmed || null,
        tidalId: null,
    };
}

async function loadSeedCanonicalRecordingId(
    seedId: string,
): Promise<string | null> {
    const identity = providerSeedIdentity(seedId);
    const mapping = await prisma.trackMapping.findFirst({
        where: {
            stale: false,
            canonicalRecordingId: { not: null },
            OR: [
                ...(identity.localId ? [{ trackId: identity.localId }] : []),
                ...(identity.youtubeVideoId
                    ? [
                          {
                              trackYtMusic: {
                                  is: { videoId: identity.youtubeVideoId },
                              },
                          },
                      ]
                    : []),
                ...(identity.tidalId
                    ? [
                          {
                              trackTidal: {
                                  is: { tidalId: identity.tidalId },
                              },
                          },
                      ]
                    : []),
            ],
        },
        orderBy: { createdAt: "desc" },
        select: { canonicalRecordingId: true },
    });
    return mapping?.canonicalRecordingId ?? null;
}

export const recommendationFeatureStore = new RecommendationFeatureStore({
    loadCanonicalFeatures,
    loadTasteRows,
    loadDislikedCanonicalKeys,
    loadSeedCanonicalRecordingId,
    loadSessionRows,
    loadContextRows,
    now: () => new Date(),
});
