import type Bull from "bull";
import { prisma } from "../utils/db";
import { decrypt } from "../utils/encryption";
import { logger } from "../utils/logger";
import { playScrobbleDispatchMetrics } from "../metrics";
import { playAccounting } from "../services/playAccounting";
import { resolveLastFmCredentials } from "../services/scrobbleConnections";
import { createScrobbleDispatchSubmitter } from "../services/playScrobbleSubmission";
import { createPlayScrobbleDispatcher } from "./playScrobbleDispatch";
import {
    createPlayScrobbleMaintenance,
    createPlayScrobbleMaintenanceLoop,
} from "./playScrobbleDispatchMaintenance";
import { createRuntimePlayScrobbleWakeupProducer } from "./playScrobbleDispatchWakeup";

const log = logger.child("PlayScrobbleDispatch");
let producer:
    | ReturnType<typeof createRuntimePlayScrobbleWakeupProducer>
    | undefined;
const dispatch = createPlayScrobbleDispatcher(prisma, {
    submit: createScrobbleDispatchSubmitter(),
    decryptCredential: decrypt,
    resolveLastFmCredentials,
    record: playScrobbleDispatchMetrics.recordOutcome,
});
const tick = createPlayScrobbleMaintenance(prisma, {
    enqueue: (wake) => {
        if (!producer) throw new Error("dispatch_wakeup_unavailable");
        return producer.enqueue(wake);
    },
    pruneReceipts: (userId, limit) =>
        playAccounting.pruneExpiredReceipts(userId, limit),
    record: playScrobbleDispatchMetrics.recordMaintenance,
});
const maintenance = createPlayScrobbleMaintenanceLoop(tick, () =>
    log.warn("Durable dispatch maintenance pass failed"),
);

/** Named lane accepts only the strict secret-free wakeup, independent of legacy jobs. */
export async function processPlayScrobbleDispatch(job: Bull.Job<unknown>) {
    return dispatch(job.data);
}

/** Starts the worker-owned startup/60s recovery loop, independently of Redis schedules. */
export function startPlayScrobbleDispatchMaintenance(): void {
    producer ??= createRuntimePlayScrobbleWakeupProducer();
    maintenance.start();
}

/** Stops intake and awaits the current database/queue batch before queue shutdown. */
export async function stopPlayScrobbleDispatchMaintenance(): Promise<void> {
    await maintenance.stop();
    await producer?.close();
    producer = undefined;
}
