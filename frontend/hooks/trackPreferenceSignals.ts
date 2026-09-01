import type { TrackPreferenceSignal } from "@/lib/api";

/**
 * Executes getNextTrackPreferenceSignal.
 */
export function getNextTrackPreferenceSignal(
    currentSignal: TrackPreferenceSignal,
): TrackPreferenceSignal {
    return currentSignal === "thumbs_up" ? "clear" : "thumbs_up";
}

/**
 * Returns the next signal when the dislike control is toggled.
 */
export function getNextTrackDislikeSignal(
    currentSignal: TrackPreferenceSignal,
): TrackPreferenceSignal {
    return currentSignal === "thumbs_down" ? "clear" : "thumbs_down";
}
