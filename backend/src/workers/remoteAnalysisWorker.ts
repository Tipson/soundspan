import { config } from "../config";
import { logger } from "../utils/logger";
import {
    processRemoteAnalysis,
    type RemoteAnalysisJob,
} from "../services/recommendations/remoteAnalysisHotSet";
import {
    startRemoteAnalysisAssetRecovery,
    stopRemoteAnalysisAssetRecovery,
} from "../services/recommendations/remoteAnalysisRecovery";
import {
    startRemoteAnalysisHotSetSweep,
    stopRemoteAnalysisHotSetSweep,
} from "../services/recommendations/remoteAnalysisHotSetSweep";
import { registerQueueProcessorEvents } from "./queueEvents";
import type { QueueProcessorEventHandlers } from "./queueEvents";
import { remoteAnalysisQueue } from "./queues";

const log = logger.child("RemoteAnalysisWorker");
type EventRecorder = NonNullable<
    QueueProcessorEventHandlers<RemoteAnalysisJob>["record"]
>;

/** Register the optional remote-analysis processor, events, and recovery loop. */
export function startRemoteAnalysisWorker(record: EventRecorder): void {
    if (
        config.features.audioAnalysis &&
        config.recommendations?.remoteAnalysisEnabled
    ) {
        remoteAnalysisQueue.process(
            "analyze",
            config.recommendations.remoteAnalysisConcurrency,
            processRemoteAnalysis,
        );
        startRemoteAnalysisHotSetSweep();
    } else {
        log.info("Remote hot-set analysis disabled; processor not registered");
    }
    registerQueueProcessorEvents(
        remoteAnalysisQueue,
        "remote-analysis-hot-set",
        {
            record,
        },
    );
    startRemoteAnalysisAssetRecovery();
}

/** Stop recovery first, then close the queue before removing its listeners. */
export async function stopRemoteAnalysisWorker(): Promise<void> {
    stopRemoteAnalysisHotSetSweep();
    await stopRemoteAnalysisAssetRecovery();
    await remoteAnalysisQueue.close();
    remoteAnalysisQueue.removeAllListeners();
}
