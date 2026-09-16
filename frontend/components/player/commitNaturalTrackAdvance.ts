import { flushSync } from "react-dom";

/** Conditions for committing a prepared queue transition from a native end event. */
export interface NaturalTrackAdvanceOptions {
    readonly advance: () => void;
    readonly isNative: boolean;
    readonly isHidden: boolean;
    readonly isPrepared: boolean;
    readonly isListenTogether: boolean;
    readonly viaWatchdog: boolean;
}

/**
 * Commits a ready native handoff before returning to the browser's end callback.
 * A deferred React commit can leave the browser without playing media long
 * enough to retire its background audio service. Call outside React lifecycles;
 * cold loads, group playback and recovery retain ordinary batching.
 */
export function commitNaturalTrackAdvance(
    options: NaturalTrackAdvanceOptions,
): void {
    if (
        options.isNative &&
        options.isHidden &&
        options.isPrepared &&
        !options.isListenTogether &&
        !options.viaWatchdog
    ) {
        flushSync(options.advance);
    } else {
        options.advance();
    }
}
