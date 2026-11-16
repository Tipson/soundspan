import type Bull from "bull";
import { recordScrobbleOutcome } from "../../metrics";
import {
    InvalidScrobbleAuthError,
    submitScrobbleJob,
} from "../../services/scrobbleSubmission";
import {
    SCROBBLE_SERVICES,
    scrobbleJobSchema,
    type ScrobbleJobData,
} from "../../services/scrobbleTypes";
import { disableInvalidScrobblerIfCurrent } from "../../services/scrobbleConnections";

export type ScrobbleProcessOutcome = "submitted" | "dropped" | "invalid_auth";

async function disableInvalidConnection(
    data: ScrobbleJobData,
    failure: InvalidScrobbleAuthError,
): Promise<void> {
    // Compare-and-swap on the exact credential the failed submission used:
    // an in-flight job holding an old credential must never disable a
    // connection the user has since reauthenticated. No ciphertext means
    // the row was already missing or disabled - nothing to change.
    const failedCredential = failure.encryptedCredential;
    if (!failedCredential) return;
    if (failure.connectionId && failure.authEpoch !== undefined) {
        await disableInvalidScrobblerIfCurrent(
            data.userId,
            data.service,
            failedCredential,
            {
                connectionId: failure.connectionId,
                authEpoch: failure.authEpoch,
            },
        );
        return;
    }
    await disableInvalidScrobblerIfCurrent(
        data.userId,
        data.service,
        failedCredential,
    );
}

/** Processes one provider job and lets Bull own bounded transient retries. */
export async function processScrobble(
    job: Bull.Job<ScrobbleJobData>,
): Promise<ScrobbleProcessOutcome> {
    const parsed = scrobbleJobSchema.safeParse(job.data);
    if (!parsed.success) {
        const service = SCROBBLE_SERVICES.find(
            (candidate) => candidate === job.data?.service,
        );
        if (service) recordScrobbleOutcome(service, "dropped");
        return "dropped";
    }
    const data = parsed.data;
    try {
        await submitScrobbleJob(data);
        recordScrobbleOutcome(data.service, "submitted");
        return "submitted";
    } catch (error: unknown) {
        if (error instanceof InvalidScrobbleAuthError) {
            await disableInvalidConnection(data, error);
            recordScrobbleOutcome(data.service, "invalid_auth");
            return "invalid_auth";
        }
        const maximumAttempts = job.opts.attempts ?? 1;
        if (job.attemptsMade + 1 < maximumAttempts) {
            recordScrobbleOutcome(data.service, "retried");
            throw error;
        }
        recordScrobbleOutcome(data.service, "dropped");
        return "dropped";
    }
}
