/**
 * iOS standalone-PWA pre-end handoff.
 *
 * WebKit can suspend an installed web app after the current media source ends
 * but before JavaScript starts the next source. This coordinator advances a
 * prepared queue item while the existing media source is still active. It is
 * deliberately platform- and visibility-gated so normal browser playback is
 * unchanged.
 */

/** Start watching for the handoff inside this end-of-track window. */
export const IOS_BACKGROUND_HANDOFF_ARM_SECONDS = 4;

/** Aim to replace the source this shortly before its natural end. */
export const IOS_BACKGROUND_HANDOFF_TARGET_REMAINING_SECONDS = 0.25;

/** Last-chance timeupdate threshold when a background timer was throttled. */
export const IOS_BACKGROUND_HANDOFF_IMMEDIATE_SECONDS = 0.35;

/** Injectable timer surface used by the handoff coordinator. */
export interface IosBackgroundTrackHandoffScheduler {
    setTimer(callback: () => void, delayMs: number): unknown;
    clearTimer(id: unknown): void;
}

/** Live playback facts required to decide whether pre-end handoff is safe. */
export interface IosBackgroundTrackHandoffInput {
    occurrenceId: string;
    activeEngine: "native" | "howler";
    isIosStandalonePwa: boolean;
    isDocumentHidden: boolean;
    isPlaying: boolean;
    isLoading: boolean;
    isListenTogether: boolean;
    repeatMode: "off" | "one" | "all";
    hasNextTrack: boolean;
    nextTrackPreloadRequested: boolean;
    currentTimeSec: number;
    durationSec: number;
}

/** Stateful one-shot coordinator for one mounted playback runtime. */
export interface IosBackgroundTrackHandoff {
    observe(input: IosBackgroundTrackHandoffInput, onHandoff: () => void): void;
    reset(): void;
}

const defaultScheduler: IosBackgroundTrackHandoffScheduler = {
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

function isEligible(input: IosBackgroundTrackHandoffInput): boolean {
    return (
        Boolean(input.occurrenceId) &&
        input.activeEngine === "native" &&
        input.isIosStandalonePwa &&
        input.isDocumentHidden &&
        input.isPlaying &&
        !input.isLoading &&
        !input.isListenTogether &&
        input.repeatMode !== "one" &&
        input.hasNextTrack &&
        input.nextTrackPreloadRequested &&
        Number.isFinite(input.currentTimeSec) &&
        Number.isFinite(input.durationSec) &&
        input.durationSec > 0 &&
        input.currentTimeSec >= 0
    );
}

/** Creates a bounded coordinator that can fire once per queue occurrence. */
export function createIosBackgroundTrackHandoff(
    scheduler: IosBackgroundTrackHandoffScheduler = defaultScheduler,
): IosBackgroundTrackHandoff {
    let observedOccurrenceId: string | null = null;
    let firedOccurrenceId: string | null = null;
    let timerId: unknown = null;

    const clearTimer = (): void => {
        if (timerId !== null) {
            scheduler.clearTimer(timerId);
            timerId = null;
        }
    };

    const reset = (): void => {
        clearTimer();
        observedOccurrenceId = null;
        firedOccurrenceId = null;
    };

    const observe = (
        input: IosBackgroundTrackHandoffInput,
        onHandoff: () => void,
    ): void => {
        if (observedOccurrenceId !== input.occurrenceId) {
            clearTimer();
            observedOccurrenceId = input.occurrenceId;
            firedOccurrenceId = null;
        }

        if (!isEligible(input)) {
            clearTimer();
            return;
        }
        if (firedOccurrenceId === input.occurrenceId) {
            return;
        }

        const remainingSec = Math.max(
            0,
            input.durationSec - input.currentTimeSec,
        );
        if (remainingSec <= IOS_BACKGROUND_HANDOFF_IMMEDIATE_SECONDS) {
            clearTimer();
            firedOccurrenceId = input.occurrenceId;
            onHandoff();
            return;
        }
        if (
            remainingSec > IOS_BACKGROUND_HANDOFF_ARM_SECONDS ||
            timerId !== null
        ) {
            return;
        }

        const delayMs = Math.max(
            0,
            (remainingSec - IOS_BACKGROUND_HANDOFF_TARGET_REMAINING_SECONDS) *
                1000,
        );
        timerId = scheduler.setTimer(() => {
            timerId = null;
            if (firedOccurrenceId === input.occurrenceId) {
                return;
            }
            firedOccurrenceId = input.occurrenceId;
            onHandoff();
        }, delayMs);
    };

    return { observe, reset };
}
