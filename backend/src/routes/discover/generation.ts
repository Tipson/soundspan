import type { Request, Response } from "express";
import { discoverQueue } from "../../workers/queues";
import { logger } from "../../utils/logger";
import { withTimeout } from "../../utils/withTimeout";
import {
    sendInternalRouteError,
    sendRouteError,
} from "../../utils/routeErrorResponse";

const ACTIVE_JOB_STATES = new Set(["active", "waiting", "delayed", "paused"]);
const log = logger.child("DiscoverGeneration");

async function canStartLocalGeneration(): Promise<boolean> {
    try {
        // Only read Redis here: a timed-out response cannot enqueue work later.
        const readiness = await withTimeout(
            () =>
                Promise.all([
                    discoverQueue.getWorkers(),
                    discoverQueue.isPaused(),
                ]),
            2_000,
            "discover generation readiness",
            log,
        );
        const queueDatabase = String(discoverQueue.client.options.db ?? 0);
        return (
            !!readiness &&
            Array.isArray(readiness[0]) &&
            readiness[0].some((worker) => worker.db === queueDatabase) &&
            !readiness[1]
        );
    } catch {
        log.warn("Local discovery generation readiness check failed");
        return false;
    }
}

/** Starts local discovery only with an available, globally unpaused consumer. */
export async function handleModernGenerate(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        if (!(await canStartLocalGeneration())) {
            return sendRouteError(
                res,
                503,
                "Local discovery generation is unavailable",
            );
        }
        const userId = req.user!.id;
        const manualJobId = `discover:manual:${userId}`;
        const existingJob = await discoverQueue.getJob(manualJobId);

        if (existingJob) {
            const state = await existingJob.getState();
            if (ACTIVE_JOB_STATES.has(state)) {
                return res.status(409).json({
                    error: "Generation already in progress",
                    jobId: existingJob.id,
                    status: state,
                });
            }
            // Reusing an unremoved ID would return the old job instead of starting a run.
            await existingJob.remove();
        }

        const job = await discoverQueue.add(
            "discover-recommendation",
            { userId },
            { jobId: manualJobId },
        );
        return res.json({
            message: "Discover Weekly recommendation generation started",
            jobId: job.id,
        });
    } catch (error) {
        log.error("Generate Discover Weekly error:", error);
        sendInternalRouteError(res, "Failed to start generation");
    }
}

/** Returns a discovery job's status only to its authenticated owner. */
export async function handleGenerateStatus(
    req: Request<{ jobId: string }>,
    res: Response,
): Promise<Response | void> {
    try {
        const job = await discoverQueue.getJob(req.params.jobId);
        if (!job || job.data?.userId !== req.user!.id) {
            return sendRouteError(res, 404, "Job not found");
        }

        const state = await job.getState();
        const progress = job.progress();
        const result = job.returnvalue;
        return res.json({ status: state, progress, result });
    } catch (error) {
        log.error("Get generation status error:", error);
        sendInternalRouteError(res, "Failed to get job status");
    }
}
