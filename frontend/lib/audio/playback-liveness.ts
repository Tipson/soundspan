const PLAYBACK_HEARTBEAT_FRESH_MS = 15_000;

let lastPlaybackHeartbeatAtMs = 0;

/** Record progress from the live audio engine in this JavaScript runtime. */
export function markPlaybackHeartbeat(nowMs: number = Date.now()): void {
    lastPlaybackHeartbeatAtMs = nowMs;
}

/** Forget runtime liveness, primarily for deterministic lifecycle tests. */
export function clearPlaybackHeartbeat(): void {
    lastPlaybackHeartbeatAtMs = 0;
}

/** Return true only for recent engine activity from this page lifetime. */
export function hasFreshPlaybackHeartbeat(nowMs: number = Date.now()): boolean {
    const ageMs = nowMs - lastPlaybackHeartbeatAtMs;
    return (
        lastPlaybackHeartbeatAtMs > 0 &&
        ageMs >= 0 &&
        ageMs <= PLAYBACK_HEARTBEAT_FRESH_MS
    );
}
