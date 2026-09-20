import {
    getPlaybackIntentGeneration,
    reservePlaybackIntent,
} from "../audio-engine/playbackAdvanceOrigin";

/** Reserves the latest queue intent without changing playback until loading succeeds. */
export async function requestRadioQueue<T>(
    load: () => Promise<T>,
): Promise<T | null> {
    const intent = reservePlaybackIntent();
    try {
        const result = await load();
        return intent === getPlaybackIntentGeneration() ? result : null;
    } catch (error) {
        if (intent !== getPlaybackIntentGeneration()) return null;
        throw error;
    }
}
