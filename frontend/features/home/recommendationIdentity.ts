import type { PersonalizedTrack } from "./types";

/** Provider identity accepted by the recommendation impression API. */
export interface RecommendationImpressionIdentity {
    provider: "youtube" | "tidal" | "library";
    providerTrackId: string;
}

/** Returns the provider identity persisted with a recommendation exposure. */
export function recommendationImpressionIdentity(
    track: PersonalizedTrack,
): RecommendationImpressionIdentity | null {
    const youtubeVideoId =
        track.youtubeVideoId ?? track.provider.youtubeVideoId;
    if (youtubeVideoId?.trim()) {
        return {
            provider: "youtube",
            providerTrackId: youtubeVideoId.trim(),
        };
    }

    const tidalTrackId = track.tidalTrackId ?? track.provider.tidalTrackId;
    if (Number.isSafeInteger(tidalTrackId) && Number(tidalTrackId) > 0) {
        return {
            provider: "tidal",
            providerTrackId: String(tidalTrackId),
        };
    }

    if (track.source === "library" && track.id.trim()) {
        return { provider: "library", providerTrackId: track.id.trim() };
    }
    return null;
}

/** Stable UI key shared by deduplication and viewport impression tracking. */
export function recommendationTrackKey(track: PersonalizedTrack): string {
    const identity = recommendationImpressionIdentity(track);
    return identity
        ? `${identity.provider}:${identity.providerTrackId}`
        : `unplayable:${track.id}`;
}
