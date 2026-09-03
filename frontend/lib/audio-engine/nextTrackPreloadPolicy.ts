/**
 * Next Track Preload Policy
 *
 * Determines whether and how the next track should be pre-loaded
 * at the point when the current track ends, before the React state
 * update cycle. This eliminates the silence gap on iOS where the OS
 * reclaims the audio session between tracks.
 */

export interface NextTrackPreloadInput {
    /** Current playback type. */
    playbackType: string | null;
    /** Repeat mode. */
    repeatMode: "off" | "one" | "all";
    /** Whether this is a listen-together session. */
    isListenTogether: boolean;
    /** Whether the engine is currently loading. */
    isLoading: boolean;
}

export interface NextTrackPreloadDecision {
    shouldPreload: boolean;
    reason: string;
}

/** Audible progress required before starting one speculative provider spool. */
export const NETWORK_PRELOAD_STABLE_PROGRESS_SECONDS = 1;

export interface NetworkNextTrackPreloadInput {
    nextStreamSource: string | null | undefined;
    currentTimeSec: number;
    isPlaying: boolean;
    isLoading: boolean;
}

/**
 * Starts one network-backed YouTube preload as soon as the current source has
 * produced stable audible progress. At that point its own provider spool has
 * completed, so the bounded sidecar can prepare the next queue item without
 * delaying startup of the track the listener actually selected.
 */
export function resolveNetworkNextTrackPreloadDecision(
    input: NetworkNextTrackPreloadInput,
): NextTrackPreloadDecision {
    if (input.nextStreamSource !== "youtube") {
        return { shouldPreload: false, reason: "not_network_youtube" };
    }
    if (!input.isPlaying || input.isLoading) {
        return { shouldPreload: false, reason: "inactive_playback" };
    }
    if (!Number.isFinite(input.currentTimeSec) || input.currentTimeSec < 0) {
        return { shouldPreload: false, reason: "invalid_timing" };
    }
    if (input.currentTimeSec < NETWORK_PRELOAD_STABLE_PROGRESS_SECONDS) {
        return { shouldPreload: false, reason: "playback_not_stable" };
    }
    return { shouldPreload: true, reason: "stable_playback" };
}

/**
 * Determines whether the next track should be eagerly loaded
 * from the ended handler before React state transitions.
 */
export function resolveNextTrackPreloadDecision(
    input: NextTrackPreloadInput,
): NextTrackPreloadDecision {
    if (input.playbackType !== "track") {
        return { shouldPreload: false, reason: "not_track_playback" };
    }

    if (input.repeatMode === "one") {
        return { shouldPreload: false, reason: "repeat_one_handles_itself" };
    }

    if (input.isListenTogether) {
        return { shouldPreload: false, reason: "listen_together_controlled" };
    }

    if (input.isLoading) {
        return { shouldPreload: false, reason: "already_loading" };
    }

    return { shouldPreload: true, reason: "eligible" };
}
