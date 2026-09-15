import { logger } from "../utils/logger";
import { playbackDiagnosticJournal } from "./playbackDiagnosticJournal";

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
    "player.engine_pause",
    "player.track_end",
    "player.visibility_change",
]);
const IDENTIFIER = /^[a-zA-Z0-9_:-]{1,128}$/;
const RETENTION_MS = 24 * 60 * 60_000;

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
        "diagnosticsVersion",
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
        "nativePaused",
        "engineEnded",
        "isLoading",
        "saveData",
        "localSource",
    ])
        if (typeof input[key] === "boolean") result[key] = input[key];
    if (input.nativePaused === null) result.nativePaused = null;
    for (const key of [
        "playbackRunId",
        "sourceKind",
        "connectionType",
        "audioContextState",
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

/** Ingestion result distinguishes durable acknowledgement from retryable delivery failure. */
export type PlaybackDiagnosticOutcome =
    | {
          status:
              | "recorded"
              | "duplicate"
              | "ignored"
              | "rejected"
              | "unavailable";
      }
    | { status: "throttled"; retryAfterSeconds: number };

/** Bound diagnostics per process: 60/user/minute, 1024 users, 128 recent IDs/user. */
export function createPlaybackDiagnosticRecorder(now: () => number = Date.now) {
    const users = new Map<
        string,
        {
            started: number;
            count: number;
            seen: Map<string, number>;
            inFlight: Map<string, Promise<PlaybackDiagnosticOutcome>>;
        }
    >();
    return async (
        userId: string,
        event: string,
        input: Record<string, unknown>,
        delivery?: PlaybackDiagnosticEnvelope,
    ): Promise<PlaybackDiagnosticOutcome> => {
        if (!EVENTS.has(event))
            return { status: delivery ? "rejected" : "ignored" };
        const time = now();
        if (
            delivery &&
            (delivery.ownerId !== userId ||
                !IDENTIFIER.test(delivery.id) ||
                !Number.isSafeInteger(delivery.observedAtMs) ||
                delivery.observedAtMs < 0 ||
                time - delivery.observedAtMs > RETENTION_MS ||
                delivery.observedAtMs - time > 60_000)
        )
            return { status: "rejected" };
        let state = users.get(userId);
        if (!state) {
            if (users.size >= 1024) users.delete(users.keys().next().value!);
            state = {
                started: time,
                count: 0,
                seen: new Map(),
                inFlight: new Map(),
            };
            users.set(userId, state);
        }
        if (time - state.started >= 60_000) {
            state.started = time;
            state.count = 0;
        }
        for (const [id, at] of state.seen)
            if (time - at >= RETENTION_MS) state.seen.delete(id);
        if (delivery && state.seen.has(delivery.id))
            return { status: "duplicate" };
        if (delivery && state.inFlight.has(delivery.id))
            return state.inFlight.get(delivery.id)!;
        if (state.count >= 60)
            return {
                status: "throttled",
                retryAfterSeconds: Math.max(
                    1,
                    Math.min(
                        60,
                        Math.ceil((state.started + 60_000 - time) / 1000),
                    ),
                ),
            };
        state.count++;
        const record = {
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
        };
        if (!delivery) {
            diagnosticLogger.warn(JSON.stringify(record));
            return { status: "recorded" };
        }
        const reservedState = state;
        const reservedWindow = state.started;
        const write: Promise<PlaybackDiagnosticOutcome> = (async () => {
            try {
                await playbackDiagnosticJournal.append(record);
                if (reservedState.seen.size >= 128)
                    reservedState.seen.delete(
                        reservedState.seen.keys().next().value!,
                    );
                reservedState.seen.set(delivery.id, now());
                // The persistent record is authoritative. Console failure must
                // not turn a completed journal append into another delivery.
                try {
                    diagnosticLogger.warn(JSON.stringify(record));
                } catch {
                    /* Persistent receipt already exists. */
                }
                return { status: "recorded" };
            } catch {
                if (reservedState.started === reservedWindow)
                    reservedState.count--;
                return { status: "unavailable" };
            }
        })();
        state.inFlight.set(delivery.id, write);
        try {
            return await write;
        } finally {
            // Register before awaiting so even a synchronous sink failure
            // cannot leave a completed promise in the in-flight map.
            if (reservedState.inFlight.get(delivery.id) === write) {
                reservedState.inFlight.delete(delivery.id);
            }
        }
    };
}

/** Shared API-process recorder; queued incidents use persistent logs, never listening history. */
export const recordPlaybackDiagnostic = createPlaybackDiagnosticRecorder();
