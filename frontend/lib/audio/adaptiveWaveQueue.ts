import type { PlaybackAdvanceOrigin } from "@/lib/audio-engine/playbackAdvanceOrigin";

const ADAPTIVE_WAVE_SKIP_THRESHOLD = 3;
const EARLY_SKIP_SECONDS = 30;
const EARLY_SKIP_RATIO = 0.2;

export interface AdaptiveWaveSkipInput {
    previousStreak: number;
    origin: PlaybackAdvanceOrigin;
    vibeMode: boolean;
    isProviderTrack: boolean;
    listenedSeconds: number;
    durationSeconds: number;
}

export interface AdaptiveWaveSkipDecision {
    nextStreak: number;
    shouldRegenerate: boolean;
}

/**
 * Decides whether a running provider Wave should replace its prepared tail.
 * Provider failures stay taste-neutral, while a meaningful manual listen or
 * leaving Wave starts a fresh streak.
 */
export function resolveAdaptiveWaveSkip(
    input: AdaptiveWaveSkipInput,
): AdaptiveWaveSkipDecision {
    if (!input.vibeMode || !input.isProviderTrack) {
        return { nextStreak: 0, shouldRegenerate: false };
    }
    if (input.origin === "error") {
        return {
            nextStreak: Math.max(0, Math.floor(input.previousStreak)),
            shouldRegenerate: false,
        };
    }
    if (input.origin !== "manual") {
        return { nextStreak: 0, shouldRegenerate: false };
    }

    const listenedSeconds = Math.max(0, input.listenedSeconds);
    const durationSeconds = Math.max(0, input.durationSeconds);
    const completionRatio =
        durationSeconds > 0 ? listenedSeconds / durationSeconds : 0;
    const isEarlySkip =
        listenedSeconds < EARLY_SKIP_SECONDS ||
        (durationSeconds > 0 && completionRatio <= EARLY_SKIP_RATIO);
    if (!isEarlySkip) {
        return { nextStreak: 0, shouldRegenerate: false };
    }

    const nextStreak = Math.max(0, Math.floor(input.previousStreak)) + 1;
    return nextStreak >= ADAPTIVE_WAVE_SKIP_THRESHOLD
        ? { nextStreak: 0, shouldRegenerate: true }
        : { nextStreak, shouldRegenerate: false };
}
