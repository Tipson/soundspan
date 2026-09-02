import type { Prisma } from "@prisma/client";

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { musicBrainzService } from "../musicbrainz";
import {
    tidalStreamingService,
    type TidalMatchResult,
} from "../tidalStreaming";
import { canonicalIdentityResolver } from "./canonicalIdentity";
import type { RecommendationCandidate } from "./types";

const log = logger.child("OnlineIdentityEnrichment");
const MAX_IDENTITY_BATCH = 25;

interface MatchedIdentity extends TidalMatchResult {
    isrc: string;
}

interface OnlineIdentityDependencies {
    findMatches: (
        userId: string,
        tracks: Array<{
            artist: string;
            title: string;
            albumTitle?: string;
            duration?: number;
        }>,
    ) => Promise<Array<TidalMatchResult | null>>;
    lookupRecordingMbidByIsrc: (isrc: string) => Promise<string | null>;
    persistIdentity: (
        candidate: RecommendationCandidate,
        identity: {
            tidalTrackId: number;
            isrc: string;
            recordingMbid: string | null;
            confidence: number;
        },
    ) => Promise<void>;
}

function normalizeIsrc(value: string | undefined): string | null {
    const normalized = value?.replace(/[^a-z0-9]/giu, "").toUpperCase() ?? "";
    return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized) ? normalized : null;
}

/** Background-only durable identity enrichment for online provider tracks. */
export class OnlineIdentityEnricher {
    constructor(private readonly dependencies: OnlineIdentityDependencies) {}

    async enrich(
        userId: string,
        candidates: readonly RecommendationCandidate[],
    ): Promise<void> {
        const tidalEligible = candidates
            .filter(
                (candidate) =>
                    candidate.source === "tidal" &&
                    Boolean(candidate.canonicalRecordingId) &&
                    !candidate.recordingMbid &&
                    candidate.provider.tidalTrackId !== null &&
                    normalizeIsrc(candidate.isrc ?? undefined) !== null,
            )
            .slice(0, MAX_IDENTITY_BATCH);
        const youtubeEligible = candidates
            .filter(
                (candidate) =>
                    candidate.source === "youtube" &&
                    Boolean(candidate.canonicalRecordingId) &&
                    !candidate.recordingMbid &&
                    !candidate.isrc,
            )
            .slice(0, MAX_IDENTITY_BATCH - tidalEligible.length);
        await Promise.allSettled(
            tidalEligible.map(async (candidate) => {
                const isrc = normalizeIsrc(candidate.isrc ?? undefined);
                const tidalTrackId = candidate.provider.tidalTrackId;
                if (!isrc || tidalTrackId === null) return;
                const recordingMbid =
                    await this.dependencies.lookupRecordingMbidByIsrc(isrc);
                await this.dependencies.persistIdentity(candidate, {
                    tidalTrackId,
                    isrc,
                    recordingMbid,
                    confidence: recordingMbid ? 0.99 : 0.95,
                });
            }),
        );
        if (youtubeEligible.length === 0) return;
        const matches = await this.dependencies.findMatches(
            userId,
            youtubeEligible.map((candidate) => ({
                artist: candidate.artist.name,
                title: candidate.title,
                albumTitle: candidate.album.title,
                duration: candidate.duration,
            })),
        );
        await Promise.allSettled(
            youtubeEligible.map(async (candidate, index) => {
                const match = matches[index];
                const isrc = normalizeIsrc(match?.isrc);
                if (!match || !isrc) return;
                const recordingMbid =
                    await this.dependencies.lookupRecordingMbidByIsrc(isrc);
                await this.dependencies.persistIdentity(candidate, {
                    tidalTrackId: match.id,
                    isrc,
                    recordingMbid,
                    confidence: recordingMbid ? 0.99 : 0.95,
                });
            }),
        );
    }
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
export async function persistOnlineIdentity(
    candidate: RecommendationCandidate,
    identity: {
        tidalTrackId: number;
        isrc: string;
        recordingMbid: string | null;
        confidence: number;
    },
): Promise<void> {
    const sourceCanonicalId = candidate.canonicalRecordingId;
    if (!sourceCanonicalId) return;
    const targetCanonicalId = await prisma.$transaction(async (transaction) => {
        const identityLockKey =
            identity.recordingMbid ?? `isrc:${identity.isrc}`;
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
                    { isrc: identity.isrc },
                ],
            },
            select: { id: true },
        });
        const targetId = existing?.id ?? sourceCanonicalId;
        if (existing) {
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
                isrc: identity.isrc,
                recordingMbid: identity.recordingMbid ?? undefined,
                identitySource: identity.recordingMbid
                    ? "musicbrainz-isrc"
                    : "tidal-isrc",
                identityConfidence: identity.confidence,
                identityVersion: 1,
                identityLookupStatus: "completed",
                identityLookupRetryCount: 0,
                identityLookupError: null,
                identityLookupUpdatedAt: new Date(),
            },
        });
        return targetId;
    });

    await canonicalIdentityResolver.resolve({
        ...candidate,
        id: `tidal:${identity.tidalTrackId}`,
        canonicalRecordingId: targetCanonicalId,
        recordingMbid: identity.recordingMbid,
        isrc: identity.isrc,
        source: "tidal",
        streamSource: "tidal",
        provider: {
            tidalTrackId: identity.tidalTrackId,
            youtubeVideoId: null,
        },
        tidalTrackId: identity.tidalTrackId,
        youtubeVideoId: undefined,
    });
}

/** Shared online identity enricher used by recommendation and worker flows. */
export const onlineIdentityEnricher = new OnlineIdentityEnricher({
    findMatches: (userId, tracks) =>
        tidalStreamingService.findMatchesForAlbum(userId, tracks),
    lookupRecordingMbidByIsrc: (isrc) =>
        musicBrainzService.lookupRecordingMbidByIsrc(isrc),
    persistIdentity: async (candidate, identity) => {
        try {
            await persistOnlineIdentity(candidate, identity);
        } catch (error) {
            log.warn("Online identity persistence failed", {
                candidateId: candidate.id,
                canonicalRecordingId: candidate.canonicalRecordingId,
                error,
            });
        }
    },
});
