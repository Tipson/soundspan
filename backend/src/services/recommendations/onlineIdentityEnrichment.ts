import { logger } from "../../utils/logger";
import { musicBrainzService } from "../musicbrainz";
import {
    tidalStreamingService,
    type TidalMatchResult,
} from "../tidalStreaming";
import {
    persistCanonicalDurableIdentity,
    type DurableIdentity,
} from "./durableIdentityPersistence";
import type { RecommendationCandidate } from "./types";

const log = logger.child("OnlineIdentityEnrichment");
const MAX_IDENTITY_BATCH = 25;

interface MatchedIdentity extends TidalMatchResult {
    isrc: string;
}

type ResolvedOnlineIdentity = DurableIdentity;

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
    lookupRecordingIdentityByMetadata: (input: {
        title: string;
        artist: string;
        duration?: number;
    }) => Promise<{
        recordingMbid: string;
        isrc: string | null;
        confidence: number;
    } | null>;
    persistIdentity: (
        candidate: RecommendationCandidate,
        identity: ResolvedOnlineIdentity,
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
                let recordingMbid: string | null = null;
                try {
                    recordingMbid =
                        await this.dependencies.lookupRecordingMbidByIsrc(isrc);
                } catch (error) {
                    log.warn("TIDAL ISRC MusicBrainz lookup degraded", {
                        candidateId: candidate.id,
                        error,
                    });
                }
                await this.dependencies.persistIdentity(candidate, {
                    tidalTrackId,
                    isrc,
                    recordingMbid,
                    confidence: recordingMbid ? 0.99 : 0.95,
                    source: recordingMbid ? "musicbrainz-isrc" : "tidal-isrc",
                });
            }),
        );
        if (youtubeEligible.length === 0) return;
        let matches: Array<TidalMatchResult | null> = [];
        try {
            matches = await this.dependencies.findMatches(
                userId,
                youtubeEligible.map((candidate) => ({
                    artist: candidate.artist.name,
                    title: candidate.title,
                    albumTitle: candidate.album.title,
                    duration: candidate.duration,
                })),
            );
        } catch (error) {
            // TIDAL is an optional accelerator. Identity enrichment must still
            // work for accounts that never configured a TIDAL session.
            log.warn("TIDAL identity matching unavailable; using metadata", {
                userId,
                error,
            });
        }
        await Promise.allSettled(
            youtubeEligible.map(async (candidate, index) => {
                const match = matches[index];
                const isrc = normalizeIsrc(match?.isrc);
                if (match && isrc) {
                    let recordingMbid: string | null = null;
                    try {
                        recordingMbid =
                            await this.dependencies.lookupRecordingMbidByIsrc(
                                isrc,
                            );
                    } catch (error) {
                        log.warn("YouTube ISRC MusicBrainz lookup degraded", {
                            candidateId: candidate.id,
                            error,
                        });
                    }
                    await this.dependencies.persistIdentity(candidate, {
                        tidalTrackId: match.id,
                        isrc,
                        recordingMbid,
                        confidence: recordingMbid ? 0.99 : 0.95,
                        source: recordingMbid
                            ? "musicbrainz-isrc"
                            : "tidal-isrc",
                    });
                    return;
                }
                let metadata: Awaited<
                    ReturnType<
                        OnlineIdentityDependencies["lookupRecordingIdentityByMetadata"]
                    >
                > = null;
                try {
                    metadata =
                        await this.dependencies.lookupRecordingIdentityByMetadata(
                            {
                                title: candidate.title,
                                artist: candidate.artist.name,
                                duration: candidate.duration,
                            },
                        );
                } catch (error) {
                    log.warn("MusicBrainz metadata identity lookup degraded", {
                        candidateId: candidate.id,
                        error,
                    });
                    return;
                }
                if (!metadata) return;
                await this.dependencies.persistIdentity(candidate, {
                    tidalTrackId: null,
                    ...metadata,
                    source: "musicbrainz-metadata",
                });
            }),
        );
    }
}

/** Compatibility seam used by recommendation and worker flows. */
export async function persistOnlineIdentity(
    candidate: RecommendationCandidate,
    identity: DurableIdentity,
): Promise<void> {
    await persistCanonicalDurableIdentity(candidate, identity);
}
/** Shared online identity enricher used by recommendation and worker flows. */
export const onlineIdentityEnricher = new OnlineIdentityEnricher({
    findMatches: (userId, tracks) =>
        tidalStreamingService.findMatchesForAlbum(userId, tracks),
    lookupRecordingMbidByIsrc: (isrc) =>
        musicBrainzService.lookupRecordingMbidByIsrc(isrc),
    lookupRecordingIdentityByMetadata: (input) =>
        musicBrainzService.lookupRecordingIdentityByMetadata(input),
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
