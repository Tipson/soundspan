import { Counter, Gauge, Histogram, type Registry } from "prom-client";
import type { PlayScrobbleMaintenanceSummary } from "../workers/playScrobbleDispatchMaintenance";

const services = new Set(["lastfm", "listenbrainz"]);
const states = new Set([
    "PENDING",
    "CLAIMED",
    "SUBMITTED",
    "REJECTED",
    "INVALID_AUTH",
    "AMBIGUOUS",
    "FAILED_NOT_SENT",
    "NO_TARGET",
    "CANCELLED",
]);
const reasons = new Set([
    "ack_submitted",
    "ack_rejected",
    "invalid_auth",
    "unknown_ack",
    "configuration_unavailable",
    "metadata_invalid",
    "expired",
    "authorization_revoked",
    "destination_missing",
    "claim_expired",
    "revoked_inflight",
]);

/** Registers only finite provider/state/reason labels, with no account or music identity. */
export function createPlayScrobbleDispatchMetrics(registry: Registry) {
    const outcomes = new Counter({
        name: "soundspan_play_dispatch_total",
        help: "Durable Play dispatch state transitions.",
        labelNames: ["service", "state", "reason"] as const,
        registers: [registry],
    });
    const maintenance = new Counter({
        name: "soundspan_play_dispatch_maintenance_total",
        help: "Bounded Play dispatch maintenance work.",
        labelNames: ["kind"] as const,
        registers: [registry],
    });
    const oldest = new Gauge({
        name: "soundspan_play_dispatch_oldest_due_seconds",
        help: "Age of the oldest due intent observed in maintenance.",
        registers: [registry],
    });
    const duration = new Histogram({
        name: "soundspan_play_dispatch_maintenance_seconds",
        help: "Completed bounded maintenance pass duration.",
        buckets: [0.01, 0.1, 1, 5, 15, 30],
        registers: [registry],
    });
    const lastSuccess = new Gauge({
        name: "soundspan_play_dispatch_maintenance_last_success_seconds",
        help: "Wall time of the last completed maintenance pass.",
        registers: [registry],
    });
    return {
        recordOutcome(service: string, state: string, reason: string) {
            outcomes.inc({
                service: services.has(service) ? service : "other",
                state: states.has(state) ? state : "other",
                reason: reasons.has(reason) ? reason : "other",
            });
        },
        recordMaintenance(summary: PlayScrobbleMaintenanceSummary) {
            for (const kind of [
                "recovered",
                "expired",
                "enqueued",
                "enqueueFailures",
                "receipts",
                "purged",
            ] as const) {
                const value = summary[kind];
                if (Number.isFinite(value) && value >= 0)
                    maintenance.inc({ kind }, value);
            }
            if (Number.isFinite(summary.oldestDueSeconds))
                oldest.set(Math.max(0, summary.oldestDueSeconds));
            if (Number.isFinite(summary.durationMs))
                duration.observe(Math.max(0, summary.durationMs) / 1000);
            lastSuccess.set(Date.now() / 1000);
        },
    };
}
