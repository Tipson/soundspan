import type { Prisma } from "@prisma/client";

import { prisma } from "../../utils/db";
import {
    canonicalIdentityResolver,
    providerTrackIdentityToCandidate,
    type ProviderTrackIdentity,
    type ResolvedCanonicalRecording,
} from "./canonicalIdentity";
import type { RecommendationCandidate } from "./types";

export type DurableIdentitySource =
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

function normalizeIsrc(value: string | null | undefined): string | null {
    const normalized = value?.replace(/[^a-z0-9]/giu, "").toUpperCase() ?? "";
    return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized) ? normalized : null;
}

async function mergeCanonicalFeatures(
    transaction: Prisma.TransactionClient,
    sourceCanonicalId: string,
    targetCanonicalId: string,
): Promise<void> {
    await transaction.$executeRaw`
        UPDATE "CanonicalRecording" AS target
        SET fingerprint = COALESCE(target.fingerprint, source.fingerprint),
            bpm = COALESCE(target.bpm, source.bpm),
            key = COALESCE(target.key, source.key),
            energy = COALESCE(target.energy, source.energy),
            loudness = COALESCE(target.loudness, source.loudness),
            valence = COALESCE(target.valence, source.valence),
            danceability = COALESCE(target.danceability, source.danceability),
            arousal = COALESCE(target.arousal, source.arousal),
            instrumentalness = COALESCE(target.instrumentalness, source.instrumentalness),
            acousticness = COALESCE(target.acousticness, source.acousticness),
            speechiness = COALESCE(target.speechiness, source.speechiness),
            "moodTags" = CASE
                WHEN cardinality(target."moodTags") = 0 THEN source."moodTags"
                ELSE target."moodTags"
            END,
            "essentiaGenres" = CASE
                WHEN cardinality(target."essentiaGenres") = 0 THEN source."essentiaGenres"
                ELSE target."essentiaGenres"
            END,
            "analysisStatus" = CASE
                WHEN target."analysisStatus" <> 'completed'
                 AND source."analysisStatus" = 'completed'
                    THEN 'completed'
                ELSE target."analysisStatus"
            END,
            "analysisVersion" = CASE
                WHEN target."analysisStatus" <> 'completed'
                 AND source."analysisStatus" = 'completed'
                    THEN source."analysisVersion"
                ELSE target."analysisVersion"
            END,
            "analyzedAt" = CASE
                WHEN target."analysisStatus" <> 'completed'
                 AND source."analysisStatus" = 'completed'
                    THEN source."analyzedAt"
                ELSE target."analyzedAt"
            END,
            "analysisError" = CASE
                WHEN source."analysisStatus" = 'completed' THEN NULL
                ELSE target."analysisError"
            END,
            "embeddingStatus" = CASE
                WHEN target."embeddingStatus" <> 'completed'
                 AND source."embeddingStatus" = 'completed'
                    THEN 'completed'
                ELSE target."embeddingStatus"
            END,
            "embeddingVersion" = CASE
                WHEN target."embeddingStatus" <> 'completed'
                 AND source."embeddingStatus" = 'completed'
                    THEN source."embeddingVersion"
                ELSE target."embeddingVersion"
            END,
            "embeddingAnalyzedAt" = CASE
                WHEN target."embeddingStatus" <> 'completed'
                 AND source."embeddingStatus" = 'completed'
                    THEN source."embeddingAnalyzedAt"
                ELSE target."embeddingAnalyzedAt"
            END,
            "embeddingError" = CASE
                WHEN source."embeddingStatus" = 'completed' THEN NULL
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
        ON CONFLICT (canonical_recording_id, space_id) DO NOTHING
    `;
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
    const promotion = await prisma.$transaction(async (transaction) => {
        const identityLockKey =
            identity.recordingMbid ?? `isrc:${identity.isrc!}`;
        await transaction.$executeRaw`
            SELECT pg_advisory_xact_lock(hashtextextended(${identityLockKey}, 0))
        `;
        const existing = await transaction.canonicalRecording.findFirst({
            where: {
                id: { not: sourceCanonicalId },
                OR: [
                    ...(identity.recordingMbid
                        ? [{ recordingMbid: identity.recordingMbid }]
                        : []),
                    ...(identity.isrc ? [{ isrc: identity.isrc }] : []),
                ],
            },
            select: { id: true },
        });
        const targetId = existing?.id ?? sourceCanonicalId;
        if (existing) {
            const sourceState = await transaction.canonicalRecording.findUnique(
                {
                    where: { id: sourceCanonicalId },
                    select: {
                        analysisStatus: true,
                        embeddingStatus: true,
                    },
                },
            );
            if (
                sourceState?.analysisStatus === "processing" ||
                sourceState?.embeddingStatus === "processing"
            ) {
                return { targetId: sourceCanonicalId, deferred: true };
            }
            await mergeCanonicalFeatures(
                transaction,
                sourceCanonicalId,
                targetId,
            );
            await transaction.trackMapping.updateMany({
                where: {
                    canonicalRecordingId: sourceCanonicalId,
                    stale: false,
                },
                data: { canonicalRecordingId: targetId },
            });
            await transaction.recommendationExposure.updateMany({
                where: { canonicalRecordingId: sourceCanonicalId },
                data: { canonicalRecordingId: targetId },
            });
            await transaction.canonicalRecording.update({
                where: { id: sourceCanonicalId },
                data: {
                    identitySource: "identity-merged",
                    identityLookupStatus: "completed",
                    identityLookupError: null,
                    identityLookupUpdatedAt: new Date(),
                },
            });
        }
        await transaction.canonicalRecording.update({
            where: { id: targetId },
            data: {
                isrc: identity.isrc ?? undefined,
                recordingMbid: identity.recordingMbid ?? undefined,
                identitySource:
                    identity.source ??
                    (identity.recordingMbid
                        ? "musicbrainz-isrc"
                        : "tidal-isrc"),
                identityConfidence: identity.confidence,
                identityVersion: 1,
                identityLookupStatus: "completed",
                identityLookupRetryCount: 0,
                identityLookupError: null,
                identityLookupUpdatedAt: new Date(),
            },
        });
        return { targetId, deferred: false };
    });

    if (promotion.deferred) return;
    const targetCanonicalId = promotion.targetId;
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
