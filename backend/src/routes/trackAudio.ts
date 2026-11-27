import { Router, raw, type RequestHandler, type Response } from "express";
import { z } from "zod";
import {
    requireAdmin,
    requireAuth,
    requireAuthOrToken,
} from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import {
    adminSurfaceLimiter,
    apiLimiter,
    streamingLimiter,
} from "../middleware/rateLimiter";
import {
    audioVersionIdSchema,
    canStreamTrackAudio,
    readPublishedTrackAudio,
    readTrackAudioVersions,
    setTrackAudioPublication,
    stageTrackAudio,
    trackAudioDirectory,
    TrackAudioError,
    trackAudioTargetSchema,
} from "../services/trackAudioVersions";
import { sendRouteError } from "../utils/routeErrorResponse";
import { createStreamProxyRequestAbort } from "./streamProxyRequestAbort";

const router = Router();
const parseMp3 = raw({ type: "audio/mpeg", limit: "16mb" });
const readMp3: RequestHandler = (req, res, next) => {
    if (!req.is("audio/mpeg"))
        return sendRouteError(res, 415, "Expected audio/mpeg");
    parseMp3(req, res, (error?: { status?: number }) => {
        if (error?.status === 413)
            return sendRouteError(res, 413, "Audio exceeds 16 MiB");
        return next(error);
    });
};

function reportVersionError(res: Response, error: unknown) {
    if (!(error instanceof TrackAudioError)) throw error;
    const status = {
        track_not_found: 404,
        invalid_audio: 422,
        version_changed: 409,
        version_file_missing: 409,
    }[error.kind];
    return sendRouteError(res, status, error.kind);
}

router.use((_req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
});

/**
 * @openapi
 * /api/track-audio/{source}/{trackId}:
 *   parameters:
 *     - { in: path, name: source, required: true, schema: { type: string, enum: [library, youtube, vk, yandex] } }
 *     - { in: path, name: trackId, required: true, schema: { type: string } }
 *   get:
 *     summary: Read the published alternate audio ID of an exact track
 *     tags: [Streaming]
 *     responses:
 *       200: { description: Published version ID or null }
 *       400: { description: Invalid track identity }
 *       401: { description: Authentication required }
 */
router.get(
    "/:source/:trackId",
    apiLimiter,
    requireAuthOrToken,
    asyncHandler(async (req, res) => {
        const target = trackAudioTargetSchema.safeParse(req.params);
        if (!target.success)
            return sendRouteError(res, 400, "Invalid track identity");
        const publishedId = await readPublishedTrackAudio(target.data);
        return res.json({ publishedId });
    }),
);

/**
 * @openapi
 * /api/track-audio/{source}/{trackId}/manage:
 *   parameters:
 *     - { in: path, name: source, required: true, schema: { type: string, enum: [library, youtube, vk, yandex] } }
 *     - { in: path, name: trackId, required: true, schema: { type: string } }
 *   get:
 *     summary: Read alternate audio draft and publication state as an administrator
 *     tags: [Streaming]
 *     responses:
 *       200: { description: Draft and published version IDs }
 *       403: { description: Administrator required }
 */
router.get(
    "/:source/:trackId/manage",
    adminSurfaceLimiter,
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const target = trackAudioTargetSchema.safeParse(req.params);
        if (!target.success)
            return sendRouteError(res, 400, "Invalid track identity");
        return res.json(await readTrackAudioVersions(target.data));
    }),
);

/**
 * @openapi
 * /api/track-audio/{source}/{trackId}/draft:
 *   parameters:
 *     - { in: path, name: source, required: true, schema: { type: string, enum: [library, youtube, vk, yandex] } }
 *     - { in: path, name: trackId, required: true, schema: { type: string } }
 *   put:
 *     summary: Upload an MP3 draft as an administrator
 *     tags: [Streaming]
 *     requestBody:
 *       required: true
 *       content:
 *         audio/mpeg:
 *           schema: { type: string, format: binary }
 *     responses:
 *       201: { description: Draft staged }
 *       403: { description: Administrator required }
 *       404: { description: Track not found }
 *       413: { description: File exceeds 16 MiB }
 *       415: { description: Unsupported media type }
 *       422: { description: Invalid MP3 }
 */
router.put(
    "/:source/:trackId/draft",
    adminSurfaceLimiter,
    requireAuth,
    requireAdmin,
    readMp3,
    asyncHandler(async (req, res) => {
        const target = trackAudioTargetSchema.safeParse(req.params);
        if (!target.success)
            return sendRouteError(res, 400, "Invalid track identity");
        if (!Buffer.isBuffer(req.body) || !req.body.length)
            return sendRouteError(res, 422, "invalid_audio");
        const lifetime = createStreamProxyRequestAbort(req, res);
        try {
            const versions = await stageTrackAudio(
                target.data,
                req.body,
                AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]),
            );
            if (!lifetime.wasClientAborted())
                return res.status(201).json(versions);
        } catch (error) {
            if (!lifetime.wasClientAborted())
                return reportVersionError(res, error);
        } finally {
            lifetime.dispose();
        }
    }),
);

/**
 * @openapi
 * /api/track-audio/{source}/{trackId}/publish:
 *   parameters:
 *     - { in: path, name: source, required: true, schema: { type: string, enum: [library, youtube, vk, yandex] } }
 *     - { in: path, name: trackId, required: true, schema: { type: string } }
 *   post:
 *     summary: Publish the specified staged audio version as an administrator
 *     tags: [Streaming]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [versionId]
 *             properties:
 *               versionId: { type: string, format: uuid }
 *     responses:
 *       200: { description: Version published }
 *       403: { description: Administrator required }
 *       409: { description: Draft was replaced or its audio file is missing }
 */
router.post(
    "/:source/:trackId/publish",
    adminSurfaceLimiter,
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const target = trackAudioTargetSchema.safeParse(req.params);
        const body = z
            .object({ versionId: audioVersionIdSchema })
            .safeParse(req.body);
        if (!target.success || !body.success)
            return sendRouteError(res, 400, "Invalid track or version");
        try {
            return res.json(
                await setTrackAudioPublication(
                    target.data,
                    body.data.versionId,
                    true,
                ),
            );
        } catch (error) {
            return reportVersionError(res, error);
        }
    }),
);

/**
 * @openapi
 * /api/track-audio/{source}/{trackId}/published/{versionId}:
 *   parameters:
 *     - { in: path, name: source, required: true, schema: { type: string, enum: [library, youtube, vk, yandex] } }
 *     - { in: path, name: trackId, required: true, schema: { type: string } }
 *     - { in: path, name: versionId, required: true, schema: { type: string, format: uuid } }
 *   delete:
 *     summary: Withdraw the specified published version as an administrator
 *     tags: [Streaming]
 *     responses:
 *       200: { description: Version withdrawn }
 *       403: { description: Administrator required }
 *       409: { description: Publication was replaced }
 */
router.delete(
    "/:source/:trackId/published/:versionId",
    adminSurfaceLimiter,
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const { versionId, ...params } = req.params;
        const target = trackAudioTargetSchema.safeParse(params);
        const id = audioVersionIdSchema.safeParse(versionId);
        if (!target.success || !id.success)
            return sendRouteError(res, 400, "Invalid track or version");
        try {
            return res.json(
                await setTrackAudioPublication(target.data, id.data, false),
            );
        } catch (error) {
            return reportVersionError(res, error);
        }
    }),
);

/**
 * @openapi
 * /api/track-audio/versions/{versionId}/stream:
 *   parameters:
 *     - { in: path, name: versionId, required: true, schema: { type: string, format: uuid } }
 *   get:
 *     summary: Stream the published version or preview a draft as an administrator
 *     tags: [Streaming]
 *     responses:
 *       200: { description: MP3 audio }
 *       206: { description: Byte range }
 *       404: { description: Unknown or unpublished version }
 *       416: { description: Invalid byte range }
 *   head:
 *     summary: Inspect the headers of an authorized audio version
 *     tags: [Streaming]
 *     responses:
 *       200: { description: Representation headers }
 *       404: { description: Unknown or unpublished version }
 */
router.get(
    "/versions/:versionId/stream",
    streamingLimiter,
    requireAuthOrToken,
    asyncHandler(async (req, res, next) => {
        const id = audioVersionIdSchema.safeParse(req.params.versionId);
        if (
            !id.success ||
            !(await canStreamTrackAudio(id.data, req.user?.role === "admin"))
        ) {
            return sendRouteError(res, 404, "Audio version not found");
        }
        res.set("ETag", `"${id.data}"`);
        res.sendFile(
            `${id.data}.mp3`,
            {
                root: trackAudioDirectory(),
                cacheControl: false,
                dotfiles: "deny",
            },
            (error) => {
                if (!error || res.destroyed) return;
                if (res.headersSent) {
                    res.destroy(error);
                    return;
                }
                const status = (error as { status?: number }).status;
                if (status === 404)
                    return sendRouteError(res, 404, "Audio version not found");
                if (status === 416)
                    return sendRouteError(res, 416, "Invalid byte range");
                next(error);
            },
        );
    }),
);

export default router;
