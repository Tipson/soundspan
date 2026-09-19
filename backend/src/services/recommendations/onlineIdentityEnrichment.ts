import { logger } from "../../utils/logger";
import { musicBrainzService } from "../musicbrainz";
import {
    persistCanonicalDurableIdentity,
    type DurableIdentity,
} from "./durableIdentityPersistence";
import type { RecommendationCandidate } from "./types";

const log = logger.child("OnlineIdentityEnrichment");
const MAX_IDENTITY_BATCH = 25;

type ResolvedOnlineIdentity = DurableIdentity;

interface OnlineIdentityDependencies {
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

/** Background-only durable identity enrichment for online provider tracks. */
export class OnlineIdentityEnricher {
    private readonly inFlight = new Map<string, Promise<void>>();

    constructor(private readonly dependencies: OnlineIdentityDependencies) {}

    async enrich(
        _userId: string,
        candidates: readonly RecommendationCandidate[],
    ): Promise<void> {
        const youtubeEligible = candidates
            .filter(
                (candidate) =>
                    candidate.source === "youtube" &&
                    Boolean(candidate.canonicalRecordingId) &&
                    !candidate.recordingMbid &&
                    !candidate.isrc,
            )
            .slice(0, MAX_IDENTITY_BATCH);
        if (youtubeEligible.length === 0) return;
        await Promise.allSettled(
            youtubeEligible.map((candidate) => {
                const key = candidate.canonicalRecordingId!;
                const existing = this.inFlight.get(key);
                if (existing) return existing;
                // Optional metadata must not grow an unbounded provider queue
                // across simultaneous account requests. Deferred recordings are
                // eligible on the next hot-set pass; no state is marked complete.
                if (this.inFlight.size >= MAX_IDENTITY_BATCH) return;
                const work = this.enrichCandidate(candidate).finally(() => {
                    this.inFlight.delete(key);
                });
                this.inFlight.set(key, work);
                return work;
            }),
        );
    }

    private async enrichCandidate(
        candidate: RecommendationCandidate,
    ): Promise<void> {
        let metadata: Awaited<
            ReturnType<
                OnlineIdentityDependencies["lookupRecordingIdentityByMetadata"]
            >
        > = null;
        try {
            metadata =
                await this.dependencies.lookupRecordingIdentityByMetadata({
                    title: candidate.title,
                    artist: candidate.artist.name,
                    duration: candidate.duration,
                });
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
