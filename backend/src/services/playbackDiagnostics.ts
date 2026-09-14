import { logger } from "../utils/logger";

const diagnosticLogger = logger.child("Playback.Diagnostic");
const EVENTS = new Set([
    "player.unexpected_stop",
    "player.unexpected_pause",
    "player.rebuffer",
    "player.rebuffer_timeout",
    "player.rebuffer_recovered",
    "player.playback_error",
    "player.recovery_attempt",
    "player.recovery_ready",
    "player.recovery_resumed",
]);
const IDENTIFIER = /^[a-zA-Z0-9_:-]{1,128}$/;

/** Sender identity for queued diagnostic delivery, never trusted as authentication. */
export interface PlaybackDiagnosticEnvelope {
    id: string;
    ownerId: string;
    observedAtMs: number;
}

/** Strict log allowlist also protects legacy clients that send arbitrary fields. */
export function sanitizePlaybackDiagnosticFields(
    input: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
    const result: Record<string, string | number | boolean | null> = {};
    for (const key of [
        "currentTimeSec",
        "durationSec",
        "bufferedAheadSec",
        "silenceSinceTimeUpdateMs",
        "debounceElapsedMs",
        "durationMs",
        "resumeAtSec",
        "attemptNumber",
        "loadId",
        "readyState",
        "networkState",
        "mediaErrorCode",
    ]) {
        const value = input[key];
        if (value === null) result[key] = null;
        else if (
            typeof value === "number" &&
            Number.isFinite(value) &&
            value >= 0 &&
            value <= 86_400_000
        )
            result[key] = value;
    }
    for (const key of [
        "online",
        "enginePlaying",
        "hasPlayIntent",
        "nearTrackEnd",
        "uiIsPlaying",
        "recoverable",
    ])
        if (typeof input[key] === "boolean") result[key] = input[key];
    for (const key of [
        "trackId",
        "sessionId",
        "sourceType",
        "reason",
        "engineMode",
        "activeEngine",
        "stateMachineState",
        "errorCode",
        "errorCategory",
        "stage",
        "visibility",
        "browser",
        "platform",
    ])
        if (typeof input[key] === "string" && IDENTIFIER.test(input[key]))
            result[key] = input[key];
    return result;
}

/** Whether a client signal needs incident diagnostics at production log levels. */
export function isPlaybackDiagnosticEvent(event: string): boolean {
    return EVENTS.has(event);
}

/** Bound diagnostics per process: 60/user/minute, 1024 users, 128 recent IDs/user. */
export function createPlaybackDiagnosticRecorder(now: () => number = Date.now) {
    const users = new Map<
        string,
        { started: number; count: number; seen: Map<string, number> }
    >();
    return (
        userId: string,
        event: string,
        input: Record<string, unknown>,
        delivery?: PlaybackDiagnosticEnvelope,
    ): void => {
        if (!EVENTS.has(event) || (delivery && delivery.ownerId !== userId))
            return;
        const time = now();
        let state = users.get(userId);
        if (!state) {
            if (users.size >= 1024) users.delete(users.keys().next().value!);
            state = { started: time, count: 0, seen: new Map() };
            users.set(userId, state);
        }
        if (time - state.started >= 60_000) {
            state.started = time;
            state.count = 0;
        }
        for (const [id, at] of state.seen)
            if (time - at >= 3_600_000) state.seen.delete(id);
        if (delivery && state.seen.has(delivery.id)) return;
        if (state.count >= 60) return;
        state.count++;
        if (delivery) {
            if (state.seen.size >= 128)
                state.seen.delete(state.seen.keys().next().value!);
            state.seen.set(delivery.id, time);
        }
        diagnosticLogger.warn(
            JSON.stringify({
                event,
                userId,
                receivedAtMs: time,
                ...(delivery
                    ? {
                          eventId: delivery.id,
                          observedAtMs: delivery.observedAtMs,
                      }
                    : {}),
                fields: sanitizePlaybackDiagnosticFields(input),
            }),
        );
    };
}

/** Shared API-process incident recorder; no database or history writes. */
export const recordPlaybackDiagnostic = createPlaybackDiagnosticRecorder();
