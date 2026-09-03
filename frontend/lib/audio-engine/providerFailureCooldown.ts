interface ProviderTrackIdentity {
    id?: string;
    playlistItemId?: string;
    streamSource?: string;
    youtubeVideoId?: string;
    tidalTrackId?: number;
}

export interface ProviderFailureCooldown {
    markUnavailable(failureKey: string): void;
    isCoolingDown(failureKey: string): boolean;
}

const DEFAULT_PROVIDER_FAILURE_COOLDOWN_MS = 10 * 60_000;

/** Stable provider asset identity shared by duplicate queue occurrences. */
export function getTrackProviderFailureKey(
    track: ProviderTrackIdentity,
): string | null {
    if (track.streamSource === "youtube" && track.youtubeVideoId?.trim()) {
        return `youtube:${track.youtubeVideoId.trim()}`;
    }
    if (
        track.streamSource === "tidal" &&
        typeof track.tidalTrackId === "number" &&
        Number.isFinite(track.tidalTrackId)
    ) {
        return `tidal:${track.tidalTrackId}`;
    }
    return null;
}

/** In-memory negative cache that never converts transient failures to blocks. */
export function createProviderFailureCooldown(
    cooldownMs: number = DEFAULT_PROVIDER_FAILURE_COOLDOWN_MS,
    now: () => number = Date.now,
): ProviderFailureCooldown {
    const unavailableUntil = new Map<string, number>();
    return {
        markUnavailable(failureKey) {
            unavailableUntil.set(failureKey, now() + cooldownMs);
        },
        isCoolingDown(failureKey) {
            const until = unavailableUntil.get(failureKey);
            if (until === undefined) return false;
            if (until <= now()) {
                unavailableUntil.delete(failureKey);
                return false;
            }
            return true;
        },
    };
}

/** Session-scoped suppression shared by every mounted player surface. */
export const providerFailureCooldown = createProviderFailureCooldown();
