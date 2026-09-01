import { logger } from "../../utils/logger";
import { recoverExpiredRemoteAnalysisAssets } from "./remoteAnalysisHotSet";

const RECOVERY_INTERVAL_MS = 15 * 60 * 1_000;
const log = logger.child("RemoteAnalysisAssetRecovery");

let recoveryInterval: ReturnType<typeof setInterval> | null = null;
let recoveryInFlight: Promise<void> | null = null;

function scheduleRecovery(reason: "startup" | "interval"): void {
    if (recoveryInFlight) return;
    recoveryInFlight = recoverExpiredRemoteAnalysisAssets()
        .then((count) => {
            if (count > 0) {
                log.info(
                    `Recovered ${count} expired remote-analysis asset(s)`,
                    {
                        reason,
                    },
                );
            }
        })
        .catch((error) => {
            log.warn("Failed to recover expired remote-analysis assets", {
                reason,
                error,
            });
        })
        .finally(() => {
            recoveryInFlight = null;
        });
}

/** Start TTL cleanup immediately and keep enforcing it without a restart. */
export function startRemoteAnalysisAssetRecovery(): void {
    if (recoveryInterval) {
        return;
    }
    scheduleRecovery("startup");
    recoveryInterval = setInterval(
        () => scheduleRecovery("interval"),
        RECOVERY_INTERVAL_MS,
    );
    recoveryInterval.unref?.();
}

/** Stop periodic admission and wait for the current cleanup pass to settle. */
export async function stopRemoteAnalysisAssetRecovery(): Promise<void> {
    if (recoveryInterval) {
        clearInterval(recoveryInterval);
        recoveryInterval = null;
    }
    await recoveryInFlight;
}
