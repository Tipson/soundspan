import { logger } from "../../utils/logger";
import { processCanonicalIdentityPromotionBatch } from "./canonicalIdentityPromotion";

const SWEEP_INTERVAL_MS = 5_000;
const log = logger.child("CanonicalIdentityPromotionSweep");

let sweepInterval: ReturnType<typeof setInterval> | null = null;
let sweepInFlight: Promise<void> | null = null;

function scheduleSweep(reason: "startup" | "interval"): void {
    if (sweepInFlight) return;
    sweepInFlight = processCanonicalIdentityPromotionBatch()
        .then((counts) => {
            const settled = counts.completed + counts.stale + counts.failed;
            if (settled > 0 || counts.deferred > 0) {
                log.info("Canonical identity promotion sweep completed", {
                    reason,
                    ...counts,
                });
            }
        })
        .catch((error) => {
            log.warn("Canonical identity promotion sweep failed", {
                reason,
                error,
            });
        })
        .finally(() => {
            sweepInFlight = null;
        });
}

/** Start immediate and bounded durable promotion settlement. */
export function startCanonicalIdentityPromotionSweep(): void {
    if (sweepInterval) return;
    scheduleSweep("startup");
    sweepInterval = setInterval(
        () => scheduleSweep("interval"),
        SWEEP_INTERVAL_MS,
    );
    sweepInterval.unref?.();
}

/** Stop new settlement and wait for the current transaction to finish. */
export async function stopCanonicalIdentityPromotionSweep(): Promise<void> {
    if (sweepInterval) {
        clearInterval(sweepInterval);
        sweepInterval = null;
    }
    await sweepInFlight;
}
