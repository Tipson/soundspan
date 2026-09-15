/** Origin of a playback action that may change or retry the active track. */
export type PlaybackAdvanceOrigin = "error" | "manual" | "feedback" | null;

/** Pending origin consumed by the first breaker-reset decision. */
export interface PlaybackAdvanceOriginMarker {
    origin: Exclude<PlaybackAdvanceOrigin, null>;
    originatingTrackId: string | null;
}

/** Classification applied when a remote consumer selects another track. */
export type RemoteTrackChangeDecision =
    | "unchanged"
    | "media-cleared"
    | "error-resync"
    | "fresh-media";

/** Single player-wide origin ref shared by control and recovery dispatchers. */
export const playbackAdvanceOriginRef: {
    current: PlaybackAdvanceOriginMarker | null;
} = { current: null };

const playbackReplacementIntentRef: {
    current: { originatingTrackId: string | null } | null;
} = { current: null };

const playbackAutoRestartSuppressedRef: { current: boolean } = {
    current: false,
};

let explicitPauseSequence = 0;
let explicitPauseGeneration = 0;
let playbackIntentGeneration = 0;

/** Fence asynchronous queue work against newer playback commands. */
export function getPlaybackIntentGeneration(): number {
    return playbackIntentGeneration;
}

/** A user seek supersedes queue work even when track and index stay the same. */
export function recordExplicitPlaybackSeek(): void {
    playbackIntentGeneration += 1;
}

/** Records an intentional UI, media-session, or synchronized pause command. */
export function recordExplicitPlaybackPause(): void {
    playbackIntentGeneration += 1;
    explicitPauseGeneration = ++explicitPauseSequence;
}

/** A later play command retires the earlier explicit pause. */
export function recordExplicitPlaybackResume(): void {
    playbackIntentGeneration += 1;
    explicitPauseGeneration = 0;
}

/** Current intentional pause generation, or zero after an explicit resume. */
export function getExplicitPlaybackPauseGeneration(): number {
    return explicitPauseGeneration;
}

/** Replaces any pending origin, so manual actions clear stale error markers. */
export function writePlaybackAdvanceOrigin(
    origin: PlaybackAdvanceOrigin,
    originatingTrackId: string | null,
): void {
    if (origin === "manual" || origin === "feedback") {
        playbackIntentGeneration += 1;
    }
    playbackReplacementIntentRef.current = null;
    playbackAdvanceOriginRef.current = origin
        ? { origin, originatingTrackId }
        : null;
}

/** Marks a manual media replacement separately from queue-only actions. */
export function writePlaybackReplacementIntent(
    originatingTrackId: string | null,
): void {
    recordExplicitPlaybackResume();
    writePlaybackAdvanceOrigin("manual", originatingTrackId);
    playbackReplacementIntentRef.current = { originatingTrackId };
}

/** True while a manual selection is waiting to replace this old track. */
export function isPlaybackFailureSupersededByManualIntent(
    failedTrackId: string | null,
): boolean {
    const marker = playbackReplacementIntentRef.current;
    return Boolean(
        failedTrackId && marker?.originatingTrackId === failedTrackId,
    );
}

/** Consumes the pending origin and re-enables restarts for a manual action. */
export function consumePlaybackAdvanceOrigin(): PlaybackAdvanceOriginMarker | null {
    const marker = playbackAdvanceOriginRef.current;
    playbackAdvanceOriginRef.current = null;
    playbackReplacementIntentRef.current = null;
    if (marker?.origin === "manual") {
        playbackAutoRestartSuppressedRef.current = false;
    }
    return marker;
}

/** Returns whether automatic playback restarts are currently suppressed. */
export function isPlaybackAutoRestartSuppressed(): boolean {
    return playbackAutoRestartSuppressedRef.current;
}

/** Updates automatic-restart suppression to match the player breaker. */
export function setPlaybackAutoRestartSuppressed(suppressed: boolean): void {
    playbackAutoRestartSuppressedRef.current = suppressed;
}

/**
 * Marks a remote track selection as fresh media unless it is the one-shot
 * result of this player's own error recovery.
 */
export function markRemoteTrackChange(
    originatingTrackId: string | null,
    newTrackId: string | null,
): RemoteTrackChangeDecision {
    if (originatingTrackId === newTrackId) return "unchanged";
    if (!newTrackId) return "media-cleared";

    const marker = playbackAdvanceOriginRef.current;
    if (
        marker?.origin === "error" &&
        marker.originatingTrackId === originatingTrackId
    ) {
        playbackAdvanceOriginRef.current = null;
        return "error-resync";
    }

    writePlaybackAdvanceOrigin("manual", originatingTrackId);
    setPlaybackAutoRestartSuppressed(false);
    return "fresh-media";
}
