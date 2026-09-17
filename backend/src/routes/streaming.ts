/** Playback client-signal ingest. The DASH session surface was removed per issue #534. */
import express from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import {
    buildPlaybackRouteTraceFields,
    logPlaybackMetric,
    logPlaybackTrace,
    playbackTraceDurationMs,
} from "../services/playbackTrace";
import { logger } from "../utils/logger";
import {
    sendInternalRouteError,
    sendRouteError,
} from "../utils/routeErrorResponse";
import { recordPlaybackClientMetric } from "../metrics";
import {
    isPlaybackDiagnosticEvent,
    recordPlaybackDiagnostic,
    sanitizePlaybackDiagnosticFields,
} from "../services/playbackDiagnostics";
import {
    playbackFeedbackSchema,
    recordPlaybackFeedback,
} from "../services/playbackFeedback";

const router = express.Router();
const playbackRouteLogger = logger.child("Playback");

const clientMetricSchema = z.object({
    event: z.string().min(1).max(128),
    fields: z.record(z.string(), z.unknown()).optional(),
    diagnostic: z
        .object({
            id: z.string().regex(/^[a-zA-Z0-9_:-]{1,128}$/),
            ownerId: z.string().regex(/^[a-zA-Z0-9_:-]{1,128}$/),
            observedAtMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        })
        .optional(),
});

function optionalStringField(
    fields: Record<string, unknown>,
    name: string,
): string | undefined {
    const value = fields[name];
    return typeof value === "string" ? value : undefined;
}

function rejectClientMetric(
    res: express.Response,
    startedAtMs: number,
    statusCode: 400 | 401,
    reason: "invalid_request" | "unauthorized",
    details?: unknown,
): express.Response {
    logPlaybackMetric("client.signal", {
        status: "reject",
        reason,
        latencyMs: playbackTraceDurationMs(startedAtMs),
    });
    return sendRouteError(
        res,
        statusCode,
        statusCode === 401 ? "Unauthorized" : "Invalid request body",
        details === undefined ? undefined : { details },
    );
}

async function acceptClientMetric(
    req: express.Request,
    res: express.Response,
    startedAtMs: number,
    userId: string,
    data: z.infer<typeof clientMetricSchema>,
): Promise<express.Response> {
    const { event } = data;
    if (
        event === "player.user_report" &&
        (!data.diagnostic ||
            !playbackFeedbackSchema.safeParse(data.fields).success)
    )
        return rejectClientMetric(res, startedAtMs, 400, "invalid_request");
    if (data.diagnostic && data.diagnostic.ownerId !== userId) {
        return rejectClientMetric(res, startedAtMs, 400, "invalid_request");
    }
    if (data.diagnostic && !isPlaybackDiagnosticEvent(event)) {
        return rejectClientMetric(res, startedAtMs, 400, "invalid_request");
    }
    const fields = isPlaybackDiagnosticEvent(event)
        ? sanitizePlaybackDiagnosticFields(data.fields ?? {})
        : (data.fields ?? {});
    const outcome = await recordPlaybackDiagnostic(
        userId,
        event,
        fields,
        data.diagnostic,
    );
    if (data.diagnostic) {
        if (outcome.status === "rejected")
            return rejectClientMetric(res, startedAtMs, 400, "invalid_request");
        if (outcome.status === "unavailable") {
            playbackRouteLogger.warn(
                "Persistent playback diagnostics unavailable",
            );
            return sendRouteError(res, 503, "Playback diagnostics unavailable");
        }
        if (outcome.status === "throttled") {
            res.setHeader("Retry-After", String(outcome.retryAfterSeconds));
            return sendRouteError(
                res,
                429,
                "Playback diagnostics rate limited",
                { retryAfterSeconds: outcome.retryAfterSeconds },
            );
        }
        if (event === "player.user_report") {
            try {
                await recordPlaybackFeedback(
                    userId,
                    data.diagnostic.id,
                    data.diagnostic.observedAtMs,
                    fields,
                );
            } catch {
                res.setHeader("Retry-After", "10");
                return sendRouteError(
                    res,
                    503,
                    "Playback feedback storage unavailable",
                );
            }
        }
        if (outcome.status === "duplicate")
            return res.status(202).json({ accepted: true });
    }
    const sessionId = optionalStringField(fields, "sessionId");
    const sourceType = optionalStringField(fields, "sourceType");
    const trackId = optionalStringField(fields, "trackId");
    recordPlaybackClientMetric({
        event,
        sourceType,
        outcome: optionalStringField(fields, "outcome"),
        reason: optionalStringField(fields, "reason"),
        durationMs:
            typeof fields.durationMs === "number"
                ? fields.durationMs
                : typeof fields.totalToAudibleMs === "number"
                  ? fields.totalToAudibleMs
                  : undefined,
    });
    logPlaybackMetric("client.signal", {
        status: "success",
        event,
        sessionId,
        sourceType,
        trackId,
        userId,
        latencyMs: playbackTraceDurationMs(startedAtMs),
    });
    const traceFields = buildPlaybackRouteTraceFields(req, startedAtMs, {
        event,
        sessionId,
        sourceType,
        trackId,
        userId,
        fields,
    });
    if (isPlaybackDiagnosticEvent(event))
        traceFields.requestPath = "/api/streaming/v1/client-metrics";
    logPlaybackTrace("playback.client.signal", traceFields);
    return res.status(202).json({ accepted: true });
}

async function handleClientMetric(
    req: express.Request,
    res: express.Response,
): Promise<express.Response> {
    const startedAtMs = Date.now();
    try {
        const userId = req.user?.id;
        if (!userId) {
            return rejectClientMetric(res, startedAtMs, 401, "unauthorized");
        }

        if (
            req.body?.diagnostic &&
            Buffer.byteLength(JSON.stringify(req.body)) > 8192
        ) {
            return sendRouteError(res, 413, "Diagnostic request too large");
        }

        const parsedBody = clientMetricSchema.safeParse(req.body ?? {});
        if (!parsedBody.success) {
            return rejectClientMetric(
                res,
                startedAtMs,
                400,
                "invalid_request",
                parsedBody.error.flatten(),
            );
        }
        return await acceptClientMetric(
            req,
            res,
            startedAtMs,
            userId,
            parsedBody.data,
        );
    } catch (error) {
        logPlaybackMetric("client.signal", {
            status: "error",
            latencyMs: playbackTraceDurationMs(startedAtMs),
        });
        playbackRouteLogger.error("Failed to ingest client signal", error);
        return sendInternalRouteError(res, "Failed to ingest client signal");
    }
}

/**
 * @openapi
 * /api/streaming/v1/client-metrics:
 *   post:
 *     summary: Ingest client-side playback metrics and signals
 *     tags: [Streaming]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - event
 *             properties:
 *               event:
 *                 type: string
 *                 maxLength: 128
 *               fields:
 *                 type: object
 *               diagnostic:
 *                 type: object
 *                 description: Optional queued-event identity; ownerId must match the authenticated listener. Queued requests contain one allowlisted incident and are limited to 8192 UTF-8 bytes. observedAtMs must be within the last 24 hours or at most 60 seconds ahead.
 *                 required: [id, ownerId, observedAtMs]
 *                 properties:
 *                   id:
 *                     type: string
 *                     maxLength: 128
 *                   ownerId:
 *                     type: string
 *                     maxLength: 128
 *                   observedAtMs:
 *                     type: integer
 *                     minimum: 0
 *     responses:
 *       202:
 *         description: Playback signal accepted. Queued incidents are acknowledged after their persistent journal append and sync succeeds; retries of a recorded event are also accepted.
 *       400:
 *         description: Invalid request body
 *       401:
 *         description: Not authenticated
 *       413:
 *         description: Queued diagnostic request exceeds the size limit
 *       429:
 *         description: Queued diagnostic rate limit; retain the event and retry after the Retry-After interval
 *       503:
 *         description: Persistent diagnostic storage is unavailable; retain the event for retry
 */
router.post("/v1/client-metrics", requireAuth, handleClientMetric);

export default router;
