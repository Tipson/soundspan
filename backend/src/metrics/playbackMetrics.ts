import { Counter, Histogram, type Registry } from "prom-client";

export type PlaybackMetricEvent =
    | "engine_startup"
    | "audible_start"
    | "transition_gap"
    | "rebuffer"
    | "rebuffer_timeout"
    | "rebuffer_recovered"
    | "unexpected_stop"
    | "unexpected_pause"
    | "load_autoplay_decision"
    | "autoplay_intent_conflict"
    | "track_end_rejected"
    | "track_end_advanced"
    | "playback_error"
    | "playback_cancelled"
    | "provider_cooldown_skip"
    | "ios_background_handoff"
    | "other";

export type PlaybackMetricSource =
    | "youtube"
    | "local"
    | "device_offline"
    | "podcast"
    | "audiobook"
    | "federation"
    | "other";

export type PlaybackMetricOutcome =
    | "audible"
    | "success"
    | "recovered"
    | "timeout"
    | "cancelled"
    | "failed"
    | "unavailable"
    | "rate_limit"
    | "client_abort"
    | "network"
    | "other";

export interface PlaybackMetricInput {
    event: string;
    sourceType?: string;
    outcome?: string;
    reason?: string;
    /** Finite nonnegative measured duration; absent or invalid values are not timed. */
    durationMs?: number;
}

type EventLabels = "event" | "source" | "outcome";
type DurationLabels = "event" | "source";

export interface PlaybackMetrics {
    events: Counter<EventLabels>;
    duration: Histogram<DurationLabels>;
    record(input: PlaybackMetricInput): void;
}

const EVENTS = new Set<PlaybackMetricEvent>([
    "engine_startup",
    "audible_start",
    "transition_gap",
    "rebuffer",
    "rebuffer_timeout",
    "rebuffer_recovered",
    "unexpected_stop",
    "unexpected_pause",
    "load_autoplay_decision",
    "autoplay_intent_conflict",
    "track_end_rejected",
    "track_end_advanced",
    "playback_error",
    "playback_cancelled",
    "provider_cooldown_skip",
    "ios_background_handoff",
]);

function normalizeEvent(event: string): PlaybackMetricEvent {
    const normalized = event.trim().replace(/^player\./, "");
    return EVENTS.has(normalized as PlaybackMetricEvent)
        ? (normalized as PlaybackMetricEvent)
        : "other";
}

function normalizeSource(sourceType?: string): PlaybackMetricSource {
    const normalized = sourceType?.trim().toLowerCase().replace(/-/g, "_");
    switch (normalized) {
        case "youtube":
        case "youtube_direct":
        case "ytmusic":
            return "youtube";
        case "local":
        case "device_offline":
        case "podcast":
        case "audiobook":
        case "federation":
            return normalized;
        default:
            return "other";
    }
}

function normalizeOutcome(
    event: PlaybackMetricEvent,
    outcome?: string,
    reason?: string,
): PlaybackMetricOutcome {
    const value = `${outcome ?? ""} ${reason ?? ""}`.trim().toLowerCase();
    if (value.includes("audible")) return "audible";
    if (value.includes("recover")) return "recovered";
    if (value.includes("rate") && value.includes("limit")) return "rate_limit";
    if (value.includes("timeout")) return "timeout";
    if (value.includes("client") && value.includes("abort")) {
        return "client_abort";
    }
    if (
        value.includes("cancel") ||
        value.includes("manual") ||
        value.includes("supersed")
    ) {
        return "cancelled";
    }
    if (
        value.includes("unavailable") ||
        value.includes("not_found") ||
        value.includes("not found") ||
        value.includes("age_restricted")
    ) {
        return "unavailable";
    }
    if (value.includes("network")) return "network";
    if (value.includes("fail") || value.includes("error")) return "failed";
    if (value.includes("success") || value.includes("advanced")) {
        return "success";
    }
    if (event === "playback_cancelled") return "cancelled";
    if (event === "rebuffer_recovered" || event === "track_end_advanced") {
        return "recovered";
    }
    return "other";
}

function normalizeDurationSeconds(durationMs?: number): number | undefined {
    if (
        typeof durationMs !== "number" ||
        !Number.isFinite(durationMs) ||
        durationMs < 0
    ) {
        return undefined;
    }
    return durationMs / 1_000;
}

/** Registers bounded, anonymous playback telemetry against one registry. */
export function createPlaybackMetrics(registry: Registry): PlaybackMetrics {
    const events = new Counter({
        name: "soundspan_playback_client_events_total",
        help: "Client playback events by bounded event, source and outcome.",
        labelNames: ["event", "source", "outcome"] as const,
        registers: [registry],
    });
    const duration = new Histogram({
        name: "soundspan_playback_client_event_seconds",
        help: "Client playback event duration by bounded event and source.",
        labelNames: ["event", "source"] as const,
        buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 15, 30, 60, 135],
        registers: [registry],
    });

    return {
        events,
        duration,
        record(input): void {
            const event = normalizeEvent(input.event);
            const source = normalizeSource(input.sourceType);
            events.inc({
                event,
                source,
                outcome: normalizeOutcome(event, input.outcome, input.reason),
            });
            const durationSeconds = normalizeDurationSeconds(input.durationMs);
            if (durationSeconds !== undefined) {
                duration.observe({ event, source }, durationSeconds);
            }
        },
    };
}
