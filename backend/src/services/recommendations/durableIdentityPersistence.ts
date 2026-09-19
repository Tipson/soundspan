import type { Prisma } from "@prisma/client";

import {
    canonicalIdentityResolver,
    providerTrackIdentityToCandidate,
    resolveCanonicalSurvivor,
    runCanonicalIdentityTransaction,
    type ProviderTrackIdentity,
    type ResolvedCanonicalRecording,
} from "./canonicalIdentity";
import type { RecommendationCandidate } from "./types";

export type DurableIdentitySource =
    | "acoustid"
    | "musicbrainz-metadata"
    | "musicbrainz-isrc"
    | "tidal-isrc"
    | "import-isrc";

export interface DurableIdentity {
    tidalTrackId: number | null;
    isrc: string | null;
    recordingMbid: string | null;
    confidence: number;
    source?: DurableIdentitySource;
}

export type DurableIdentityPersistenceResult =
    | { status: "completed"; targetCanonicalId: string }
    | { status: "deferred"; targetCanonicalId: string }
    | { status: "stale"; targetCanonicalId: null };

export interface CanonicalIdentityPromotionFence {
    expectedFingerprint: string;
    expectedLookupStatus: "merge_pending";
}

const ACTIVE_ANALYSIS_LEASE_STATUSES = [
    "downloading",
    "downloaded",
    "queued_essentia",
    "processing",
    "expiring",
    "cleanup_failed",
] as const;

function normalizeIsrc(value: string | null | undefined): string | null {
    const normalized = value?.replace(/[^a-z0-9]/giu, "").toUpperCase() ?? "";
    return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized) ? normalized : null;
}

async function mergeCanonicalFeatures(
    transaction: Prisma.TransactionClient,
    sourceCanonicalId: string,
    targetCanonicalId: string,
    policy: {
        preferSourceAnalysis: boolean;
        preferSourceEmbedding: boolean;
        sourceEmbeddingCompleted: boolean;
    },
): Promise<void> {
    await transaction.$executeRaw`
        UPDATE "CanonicalRecording" AS target
        SET fingerprint = COALESCE(target.fingerprint, source.fingerprint),
            bpm = CASE WHEN ${policy.preferSourceAnalysis} THEN source.bpm ELSE target.bpm END,
            key = CASE WHEN ${policy.preferSourceAnalysis} THEN source.key ELSE target.key END,
            energy = CASE WHEN ${policy.preferSourceAnalysis} THEN source.energy ELSE target.energy END,
            loudness = CASE WHEN ${policy.preferSourceAnalysis} THEN source.loudness ELSE target.loudness END,
            valence = CASE WHEN ${policy.preferSourceAnalysis} THEN source.valence ELSE target.valence END,
            danceability = CASE WHEN ${policy.preferSourceAnalysis} THEN source.danceability ELSE target.danceability END,
            arousal = CASE WHEN ${policy.preferSourceAnalysis} THEN source.arousal ELSE target.arousal END,
            instrumentalness = CASE WHEN ${policy.preferSourceAnalysis} THEN source.instrumentalness ELSE target.instrumentalness END,
            acousticness = CASE WHEN ${policy.preferSourceAnalysis} THEN source.acousticness ELSE target.acousticness END,
            speechiness = CASE WHEN ${policy.preferSourceAnalysis} THEN source.speechiness ELSE target.speechiness END,
            "moodTags" = CASE
                WHEN ${policy.preferSourceAnalysis} THEN source."moodTags"
                ELSE target."moodTags"
            END,
            "essentiaGenres" = CASE
                WHEN ${policy.preferSourceAnalysis} THEN source."essentiaGenres"
                ELSE target."essentiaGenres"
            END,
            "analysisStatus" = CASE
                WHEN ${policy.preferSourceAnalysis} THEN source."analysisStatus"
                ELSE target."analysisStatus"
            END,
            "analysisVersion" = CASE
                WHEN ${policy.preferSourceAnalysis} THEN source."analysisVersion"
                ELSE target."analysisVersion"
            END,
            "analyzedAt" = CASE
                WHEN ${policy.preferSourceAnalysis} THEN source."analyzedAt"
                ELSE target."analyzedAt"
            END,
            "analysisError" = CASE
                WHEN ${policy.preferSourceAnalysis} THEN source."analysisError"
                ELSE target."analysisError"
            END,
            "embeddingStatus" = CASE
                WHEN ${policy.preferSourceEmbedding} THEN source."embeddingStatus"
                ELSE target."embeddingStatus"
            END,
            "embeddingVersion" = CASE
                WHEN ${policy.preferSourceEmbedding} THEN source."embeddingVersion"
                ELSE target."embeddingVersion"
            END,
            "embeddingAnalyzedAt" = CASE
                WHEN ${policy.preferSourceEmbedding} THEN source."embeddingAnalyzedAt"
                ELSE target."embeddingAnalyzedAt"
            END,
            "embeddingError" = CASE
                WHEN ${policy.preferSourceEmbedding} THEN source."embeddingError"
                ELSE target."embeddingError"
            END,
            "updatedAt" = NOW()
        FROM "CanonicalRecording" AS source
        WHERE source.id = ${sourceCanonicalId}
          AND target.id = ${targetCanonicalId}
    `;
    await transaction.$executeRaw`
        INSERT INTO canonical_recording_embeddings (
            canonical_recording_id,
            space_id,
            embedding,
            analyzed_at
        )
        SELECT ${targetCanonicalId}, space_id, embedding, analyzed_at
        FROM canonical_recording_embeddings
        WHERE canonical_recording_id = ${sourceCanonicalId}
          AND ${policy.sourceEmbeddingCompleted}
        ON CONFLICT (canonical_recording_id, space_id) DO UPDATE
        SET embedding = EXCLUDED.embedding,
            analyzed_at = EXCLUDED.analyzed_at
        WHERE ${policy.preferSourceEmbedding}
    `;
}

/** Apply one durable identity promotion inside its caller-owned transaction. */
export async function persistCanonicalDurableIdentityInTransaction(
    transaction: Prisma.TransactionClient,
    candidate: RecommendationCandidate,
    identity: DurableIdentity,
    fence?: CanonicalIdentityPromotionFence,
): Promise<DurableIdentityPersistenceResult> {
    const sourceCanonicalId = candidate.canonicalRecordingId;
    if (!sourceCanonicalId || (!identity.recordingMbid && !identity.isrc)) {
        throw new Error("Canonical identity promotion is incomplete");
    }
    const identityLockKey = identity.recordingMbid ?? `isrc:${identity.isrc!}`;
    await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${identityLockKey}, 0))
    `;
    const sourceAlias = await transaction.canonicalRecording.findUnique({
        where: { id: sourceCanonicalId },
        select: {
            id: true,
            canonicalKey: true,
            mergedIntoId: true,
            identitySource: true,
            recordingMbid: true,
            isrc: true,
            fingerprint: true,
            identityLookupStatus: true,
        },
    });
    if (!sourceAlias) {
        throw new Error("Canonical recording is missing");
    }
    if (
        fence &&
        (sourceAlias.fingerprint !== fence.expectedFingerprint ||
            sourceAlias.identityLookupStatus !== fence.expectedLookupStatus ||
            sourceAlias.mergedIntoId !== null)
    ) {
        return { status: "stale", targetCanonicalId: null };
    }
    if (
        (identity.recordingMbid &&
            sourceAlias.recordingMbid &&
            identity.recordingMbid !== sourceAlias.recordingMbid) ||
        (identity.isrc &&
            sourceAlias.isrc &&
            identity.isrc !== sourceAlias.isrc)
    ) {
        throw new Error(
            "Canonical identity conflicts with its source recording",
        );
    }
    const source = await resolveCanonicalSurvivor(transaction, sourceAlias);
    const identityMatchSelect = {
        id: true,
        canonicalKey: true,
        mergedIntoId: true,
        identitySource: true,
        recordingMbid: true,
        isrc: true,
    } as const;
    const [recordingMbidMatch, isrcMatches] = await Promise.all([
        identity.recordingMbid
            ? transaction.canonicalRecording.findFirst({
                  where: {
                      id: { not: source.id },
                      mergedIntoId: null,
                      NOT: { identitySource: "identity-merged" },
                      recordingMbid: identity.recordingMbid,
                  },
                  select: identityMatchSelect,
              })
            : null,
        identity.isrc
            ? transaction.canonicalRecording.findMany({
                  where: {
                      id: { not: source.id },
                      mergedIntoId: null,
                      NOT: { identitySource: "identity-merged" },
                      isrc: identity.isrc,
                  },
                  select: identityMatchSelect,
                  take: 2,
              })
            : [],
    ]);
    if (isrcMatches.length > 1) {
        throw new Error(
            "Canonical identity resolves to multiple canonical survivors",
        );
    }
    const isrcMatch = isrcMatches[0] ?? null;
    if (
        recordingMbidMatch &&
        isrcMatch &&
        recordingMbidMatch.id !== isrcMatch.id
    ) {
        throw new Error(
            "Canonical identity resolves to multiple canonical survivors",
        );
    }
    const existing = recordingMbidMatch ?? isrcMatch;
    if (
        existing &&
        ((identity.recordingMbid &&
            existing.recordingMbid &&
            identity.recordingMbid !== existing.recordingMbid) ||
            (identity.isrc && existing.isrc && identity.isrc !== existing.isrc))
    ) {
        throw new Error("Canonical identity conflicts with its survivor");
    }
    const target = existing
        ? await resolveCanonicalSurvivor(transaction, existing)
        : source;
    const targetId = target.id;
    if (existing) {
        const now = new Date();
        const [sourceState, targetState, activeChildAlias] = await Promise.all([
            transaction.canonicalRecording.findUnique({
                where: { id: source.id },
                select: {
                    analysisStatus: true,
                    embeddingStatus: true,
                    analysisLeases: {
                        where: {
                            status: {
                                in: [...ACTIVE_ANALYSIS_LEASE_STATUSES],
                            },
                            expiresAt: { gt: now },
                        },
                        select: { id: true },
                        take: 1,
                    },
                },
            }),
            transaction.canonicalRecording.findUnique({
                where: { id: targetId },
                select: {
                    analysisStatus: true,
                    embeddingStatus: true,
                    analysisLeases: {
                        where: {
                            status: {
                                in: [...ACTIVE_ANALYSIS_LEASE_STATUSES],
                            },
                            expiresAt: { gt: now },
                        },
                        select: { id: true },
                        take: 1,
                    },
                },
            }),
            transaction.canonicalRecording.findFirst({
                where: {
                    mergedIntoId: source.id,
                    OR: [
                        { analysisStatus: "processing" },
                        { embeddingStatus: "processing" },
                        {
                            analysisLeases: {
                                some: {
                                    status: {
                                        in: [...ACTIVE_ANALYSIS_LEASE_STATUSES],
                                    },
                                    expiresAt: { gt: now },
                                },
                            },
                        },
                    ],
                },
                select: { id: true },
            }),
        ]);
        if (
            sourceState?.analysisStatus === "processing" ||
            sourceState?.embeddingStatus === "processing" ||
            targetState?.analysisStatus === "processing" ||
            targetState?.embeddingStatus === "processing" ||
            (sourceState?.analysisLeases?.length ?? 0) > 0 ||
            (targetState?.analysisLeases?.length ?? 0) > 0 ||
            activeChildAlias !== null
        ) {
            return { status: "deferred", targetCanonicalId: source.id };
        }
        const preferSourceAnalysis =
            targetState?.analysisStatus !== "completed" &&
            sourceState?.analysisStatus === "completed";
        const preferSourceEmbedding =
            targetState?.embeddingStatus !== "completed" &&
            sourceState?.embeddingStatus === "completed";
        await mergeCanonicalFeatures(transaction, source.id, targetId, {
            preferSourceAnalysis,
            preferSourceEmbedding,
            sourceEmbeddingCompleted:
                sourceState?.embeddingStatus === "completed",
        });
        await transaction.trackMapping.updateMany({
            where: {
                canonicalRecordingId: source.id,
                stale: false,
            },
            data: { canonicalRecordingId: targetId },
        });
        await transaction.recommendationExposure.updateMany({
            where: { canonicalRecordingId: source.id },
            data: {
                canonicalRecordingId: targetId,
                canonicalKey: target.canonicalKey,
            },
        });
        await transaction.canonicalRecording.updateMany({
            where: { mergedIntoId: source.id },
            data: { mergedIntoId: targetId },
        });
        await transaction.canonicalRecording.update({
            where: { id: source.id },
            data: {
                mergedIntoId: targetId,
                identitySource: "identity-merged",
                identityLookupStatus: "completed",
                identityLookupError: null,
                identityLookupUpdatedAt: new Date(),
            },
        });
    }
    const targetIdentity =
        await transaction.canonicalRecording.findUniqueOrThrow({
            where: { id: targetId },
            select: {
                recordingMbid: true,
                isrc: true,
                identitySource: true,
                identityConfidence: true,
                identityVersion: true,
            },
        });
    const preserveExistingProvenance =
        Boolean(targetIdentity.recordingMbid || targetIdentity.isrc) &&
        (targetIdentity.identityVersion > 1 ||
            targetIdentity.identityConfidence >= identity.confidence);
    await transaction.canonicalRecording.update({
        where: { id: targetId },
        data: {
            isrc: targetIdentity.isrc ?? identity.isrc ?? undefined,
            recordingMbid:
                targetIdentity.recordingMbid ??
                identity.recordingMbid ??
                undefined,
            identitySource: preserveExistingProvenance
                ? undefined
                : (identity.source ??
                  (identity.recordingMbid ? "musicbrainz-isrc" : "tidal-isrc")),
            identityConfidence: preserveExistingProvenance
                ? undefined
                : identity.confidence,
            identityVersion: preserveExistingProvenance
                ? undefined
                : Math.max(1, targetIdentity.identityVersion),
            identityLookupStatus: "completed",
            identityLookupRetryCount: 0,
            identityLookupError: null,
            identityLookupUpdatedAt: new Date(),
        },
    });
    return { status: "completed", targetCanonicalId: targetId };
}

/** Persist durable ISRC/MBID identity and merge provider mappings atomically. */
export async function persistCanonicalDurableIdentity(
    candidate: RecommendationCandidate,
    identity: DurableIdentity,
): Promise<void> {
    const sourceCanonicalId = candidate.canonicalRecordingId;
    if (!sourceCanonicalId || (!identity.recordingMbid && !identity.isrc)) {
        return;
    }
    const promotion = await runCanonicalIdentityTransaction((transaction) =>
        persistCanonicalDurableIdentityInTransaction(
            transaction,
            candidate,
            identity,
        ),
    );

    if (promotion.status !== "completed") return;
    const targetCanonicalId = promotion.targetCanonicalId;
    if (identity.tidalTrackId === null) return;
    await canonicalIdentityResolver.resolve({
        ...candidate,
        id: `tidal:${identity.tidalTrackId}`,
        canonicalRecordingId: targetCanonicalId,
        recordingMbid: identity.recordingMbid,
        isrc: identity.isrc,
        source: "tidal",
        streamSource: "tidal",
        provider: { tidalTrackId: identity.tidalTrackId, youtubeVideoId: null },
        tidalTrackId: identity.tidalTrackId,
        youtubeVideoId: undefined,
    });
}

/** Preserve imported Spotify identity even for an already-mapped provider row. */
export async function persistImportedProviderIdentity(
    input: ProviderTrackIdentity,
    canonical: ResolvedCanonicalRecording,
): Promise<void> {
    const isrc = normalizeIsrc(input.isrc);
    const recordingMbid = input.recordingMbid?.trim() || null;
    if (!isrc && !recordingMbid) return;
    const candidate = providerTrackIdentityToCandidate(input);
    candidate.canonicalRecordingId = canonical.id;
    const tidalTrackId =
        input.source === "tidal" &&
        Number.isSafeInteger(Number(input.providerTrackId))
            ? Number(input.providerTrackId)
            : null;
    await persistCanonicalDurableIdentity(candidate, {
        tidalTrackId,
        isrc,
        recordingMbid,
        confidence: recordingMbid ? 0.99 : 0.97,
        source: "import-isrc",
    });
}
