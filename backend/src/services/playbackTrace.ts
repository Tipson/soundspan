import type { Request } from "express";
import { logger } from "../utils/logger";
import { config } from "../config";
import type { PlayStageSample } from "./playRequestTrace";

const playbackMetricLogger = logger.child("Playback.Metric");
const playbackTraceLogger = logger.child("Playback.Trace");

/** Whether playback trace logs were enabled when this module loaded. */
export const playbackTraceEnabled = config.streaming.traceEnabled;

/** Return the non-negative elapsed time for a playback trace operation. */
export const playbackTraceDurationMs = (startedAtMs: number): number =>
    Math.max(0, Date.now() - startedAtMs);

/** Add request-path and latency context to playback trace fields. */
export const buildPlaybackRouteTraceFields = (
    req: Request,
    startedAtMs: number,
    fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
    ...fields,
    requestPath: req.originalUrl || req.path,
    latencyMs: playbackTraceDurationMs(startedAtMs),
});

/** Add error, request-path, and latency context to playback trace fields. */
export const buildPlaybackRouteTraceErrorFields = (
    req: Request,
    startedAtMs: number,
    errorFields: Record<string, unknown>,
    fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
    ...fields,
    requestPath: req.originalUrl || req.path,
    ...errorFields,
    latencyMs: playbackTraceDurationMs(startedAtMs),
});

/** Emit an always-on playback metric through the neutral metric logger. */
export const logPlaybackMetric = (
    event: string,
    fields: Record<string, unknown>,
): void => {
    playbackMetricLogger.info(event, fields);
};

/** Emit a gated playback trace event through the neutral trace logger. */
export const logPlaybackTrace = (
    event: string,
    fields: Record<string, unknown> = {},
): void => {
    if (!playbackTraceEnabled) {
        return;
    }

    playbackTraceLogger.info(event, {
        timestamp: new Date().toISOString(),
        ...fields,
    });
};

/** Emit anonymous stage samples with request-local, validated correlation only. */
export const logPlayRequestStage = (
    event: string,
    fields: Record<string, unknown>,
): void => {
    const sample = fields as unknown as PlayStageSample;
    // Production defaults to warn; keep incident and late completion evidence
    // visible without enabling successful-request trace traffic.
    if (sample.outcome !== "success") {
        playbackMetricLogger.warn(event, fields);
    } else {
        logPlaybackTrace(event, fields);
    }
};
