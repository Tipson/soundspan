import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { playlistImportService } from "../services/playlistImportService";
import { importJobStore } from "../services/importJobStore";
import { genericImportJobRunner } from "../services/genericImportJobRunner";
import { logger } from "../utils/logger";
import {
    sendInternalRouteError,
    sendRouteError,
} from "../utils/routeErrorResponse";
import { ImportDraftError } from "../services/importDraftParser";

const router = Router();
const log = logger.child("PlaylistImportRoute");

const draftUploadSchema = z.object({
    format: z.enum(["text", "spotify-json"]),
    content: z.string(),
    name: z.string().trim().min(1).max(200).optional(),
    textCategory: z.enum(["playlists", "likes", "dislikes"]).optional(),
});
const draftRevisionSchema = z.number().int().min(1).max(2_147_483_646);
const draftConfirmSchema = z
    .object({
        revision: draftRevisionSchema,
        previewRevision: draftRevisionSchema,
        mappingDigest: z.string().regex(/^[a-f0-9]{64}$/),
        categories: z
            .array(
                z.enum(["playlists", "likes", "albums", "artists", "dislikes"]),
            )
            .min(1)
            .max(5),
    })
    .strict();
function draftRoute(
    operation: (req: Request, res: Response) => Promise<unknown>,
) {
    return async (req: Request, res: Response) => {
        try {
            await operation(req, res);
        } catch (error) {
            if (error instanceof ImportDraftError)
                return sendRouteError(res, error.status, error.code);
            log.error("Import draft operation failed", {
                errorType: error instanceof Error ? error.name : "unknown",
            });
            return sendInternalRouteError(res, "import_draft_failed");
        }
    };
}
function draftId(req: Request): string {
    const id = req.params.draftId;
    if (typeof id !== "string" || id.length < 1 || id.length > 128)
        throw new ImportDraftError("import_draft_not_found", 404);
    return id;
}
router.use("/drafts", (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
});

/**
 * @openapi
 * /api/import/drafts:
 *   post:
 *     summary: Store a bounded owner-only text or Spotify JSON export draft without importing effects
 *     tags: [Import]
 *     responses:
 *       201: { description: Normalized draft with server sourceHash and revision }
 *       400: { description: Malformed or unsupported export }
 *       401: { description: Authentication required }
 *       413: { description: File exceeds explicit byte or entry bounds }
 */
router.post(
    "/drafts",
    requireAuth,
    draftRoute(async (req, res) => {
        const parsed = draftUploadSchema.safeParse(req.body);
        if (!parsed.success) throw new ImportDraftError("import_file_invalid");
        const { importDraftService } =
            await import("../services/importDraftService");
        res.status(201).json({
            job: await importDraftService.create(req.user!.id, parsed.data),
        });
    }),
);
/**
 * @openapi
 * /api/import/drafts/{draftId}:
 *   get:
 *     summary: Read the current user's import draft, matching confidence and retained unresolved positions
 *     tags: [Import]
 *     responses:
 *       200: { description: Owner-only draft and committed effect receipt }
 *       401: { description: Authentication required }
 *       403: { description: Draft belongs to another user }
 *       404: { description: Draft not found }
 *   put:
 *     summary: Replace an unconfirmed draft at an expected revision and retire old matching authority
 *     tags: [Import]
 *     responses:
 *       200: { description: New revision requiring another preview }
 *       400: { description: Invalid input }
 *       401: { description: Authentication required }
 *       403: { description: Draft belongs to another user }
 *       409: { description: Stale revision or immutable confirmed draft }
 */
router.get(
    "/drafts/:draftId",
    requireAuth,
    draftRoute(async (req, res) => {
        const { importDraftService } =
            await import("../services/importDraftService");
        res.json({
            job: await importDraftService.get(req.user!.id, draftId(req)),
        });
    }),
);
router.put(
    "/drafts/:draftId",
    requireAuth,
    draftRoute(async (req, res) => {
        const parsed = draftUploadSchema
            .extend({ revision: draftRevisionSchema })
            .safeParse(req.body);
        if (!parsed.success) throw new ImportDraftError("import_file_invalid");
        const { revision, ...upload } = parsed.data;
        const { importDraftService } =
            await import("../services/importDraftService");
        res.json({
            job: await importDraftService.update(
                req.user!.id,
                draftId(req),
                revision,
                upload,
            ),
        });
    }),
);
/**
 * @openapi
 * /api/import/drafts/{draftId}/preview:
 *   post:
 *     summary: Queue read-only matching for the exact stored draft revision
 *     tags: [Import]
 *     responses:
 *       202: { description: Preview job queued on the existing durable import runner }
 *       400: { description: Revision required }
 *       401: { description: Authentication required }
 *       403: { description: Draft belongs to another user }
 *       409: { description: Draft revision changed }
 */
router.post(
    "/drafts/:draftId/preview",
    requireAuth,
    draftRoute(async (req, res) => {
        const parsed = z
            .object({ revision: draftRevisionSchema })
            .strict()
            .safeParse(req.body);
        if (!parsed.success) throw new ImportDraftError("import_file_invalid");
        const { importDraftService } =
            await import("../services/importDraftService");
        const job = await importDraftService.requestPreview(
            req.user!.id,
            draftId(req),
            parsed.data.revision,
        );
        genericImportJobRunner.enqueue(job.id, job.resolutionAttempt, {
            version: 1,
            revision: job.draftRevision,
            attempt: job.resolutionAttempt,
        });
        res.status(202).json({ job });
    }),
);
/**
 * @openapi
 * /api/import/drafts/{draftId}/confirm:
 *   post:
 *     summary: Confirm explicit categories against a server-stored matching digest, idempotently
 *     tags: [Import]
 *     responses:
 *       202: { description: Immutable confirmed snapshot queued; no client matching IDs are accepted }
 *       400: { description: Explicit category selection and preview token required }
 *       401: { description: Authentication required }
 *       403: { description: Draft belongs to another user }
 *       409: { description: Stale draft or preview revision }
 */
router.post(
    "/drafts/:draftId/confirm",
    requireAuth,
    draftRoute(async (req, res) => {
        const parsed = draftConfirmSchema.safeParse(req.body);
        if (!parsed.success)
            throw new ImportDraftError("import_selection_invalid");
        const { importDraftService } =
            await import("../services/importDraftService");
        const job = await importDraftService.confirm(
            req.user!.id,
            draftId(req),
            parsed.data,
        );
        if (job.status !== "completed")
            genericImportJobRunner.enqueue(job.id, job.resolutionAttempt, {
                version: 1,
                revision: job.draftRevision,
                attempt: job.resolutionAttempt,
            });
        res.status(job.status === "completed" ? 200 : 202).json({ job });
    }),
);

const urlSchema = z.object({
    url: z.string().url(),
});

const resolvedTrackSchema = z
    .object({
        index: z.number(),
        artist: z.string(),
        title: z.string(),
        album: z.string().optional(),
        trackId: z.string().optional(),
        trackYtMusicId: z.string().optional(),
        trackTidalId: z.string().optional(),
        source: z.enum(["local", "youtube", "tidal", "unresolved"]),
        confidence: z.number(),
    })
    .refine(
        (t) => {
            if (t.source === "local") return !!t.trackId;
            if (t.source === "youtube") return !!t.trackYtMusicId;
            if (t.source === "tidal") return !!t.trackTidalId;
            return true; // unresolved has no ID requirement
        },
        {
            message:
                "Resolved track source/ID mismatch: local requires trackId, youtube requires trackYtMusicId, tidal requires trackTidalId",
        },
    );

const summarySchema = z.object({
    total: z.number(),
    local: z.number(),
    youtube: z.number(),
    tidal: z.number(),
    unresolved: z.number(),
});

const executeSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    previewData: z.object({
        playlistName: z.string(),
        resolved: z.array(resolvedTrackSchema),
        summary: summarySchema,
    }),
});

const submitJobSchema = z.object({
    url: z.string().url(),
    name: z.string().min(1).max(200).optional(),
});

const reconnectJobSchema = z.object({
    url: z.string().url(),
});

function buildNormalizedSource(sourceType: string, sourceId: string): string {
    return `${sourceType.trim().toLowerCase()}:${sourceId.trim()}`;
}

function toDefaultPlaylistName(sourceType: string): string {
    const normalized = sourceType.trim().toLowerCase();
    return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)} import`;
}

/**
 * @openapi
 * /api/import/preview:
 *   post:
 *     summary: Preview playlist import — resolve all tracks without creating playlist
 *     tags: [Import]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               url:
 *                 type: string
 *                 description: Public Yandex Music, Spotify, Deezer, or YouTube Music playlist URL
 *     responses:
 *       200:
 *         description: Track resolution preview
 *       400:
 *         description: Invalid or unsupported URL
 *       401:
 *         description: Not authenticated
 */
/**
 * @openapi
 * /api/import/jobs:
 *   post:
 *     summary: Submit a background generic import job for a provider URL
 *     tags: [Import]
 *     responses:
 *       200:
 *         description: Existing active job returned for duplicate source submissions
 *       202:
 *         description: New generic import job created
 */
router.post("/jobs", requireAuth, async (req: Request, res: Response) => {
    try {
        const parsed = submitJobSchema.safeParse(req.body);
        if (!parsed.success) {
            return res
                .status(400)
                .json({ error: "Valid playlist URL is required" });
        }

        const parsedSource = playlistImportService.parseSourceUrl(
            parsed.data.url,
        );
        if (!parsedSource) {
            return res.status(400).json({ error: "Unsupported playlist URL" });
        }

        const claim = await importJobStore.claimJob({
            userId: req.user!.id,
            sourceType: parsedSource.source,
            sourceId: parsedSource.id,
            sourceUrl: parsed.data.url,
            playlistName: toDefaultPlaylistName(parsedSource.source),
            requestedPlaylistName: parsed.data.name,
            status: "pending",
            progress: 0,
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });
        genericImportJobRunner.enqueue(claim.job.id);

        if (!claim.created) {
            return res.status(200).json({
                deduped: true,
                job: claim.job,
            });
        }

        res.status(202).json({
            deduped: false,
            job: claim.job,
        });
    } catch (err) {
        logger.error("[Import] Job submit failed:", err);
        res.status(500).json({ error: "Failed to submit import job" });
    }
});

/**
 * @openapi
 * /api/import/jobs:
 *   get:
 *     summary: List generic import jobs for the current user
 *     description: Legacy statuses only by default; draft-aware clients explicitly opt in before database paging.
 *     tags: [Import]
 *     parameters:
 *       - in: query
 *         name: includeDrafts
 *         schema: { type: string, enum: ['0', '1'] }
 *     responses:
 *       200:
 *         description: User-scoped import jobs
 */
router.get("/jobs", requireAuth, async (req: Request, res: Response) => {
    try {
        const query = z
            .object({ includeDrafts: z.enum(["0", "1"]).optional() })
            .safeParse(req.query);
        if (!query.success)
            return sendRouteError(res, 400, "import_list_options_invalid");
        const jobs =
            query.data.includeDrafts === "1"
                ? await importJobStore.listJobsForUser(req.user!.id, 25, {
                      includeDrafts: true,
                  })
                : await importJobStore.listJobsForUser(req.user!.id);
        res.setHeader("Cache-Control", "private, no-store");
        res.json({ jobs });
    } catch (err) {
        logger.error("[Import] Job list failed:", err);
        res.status(500).json({ error: "Failed to list import jobs" });
    }
});

/**
 * @openapi
 * /api/import/jobs/{jobId}:
 *   get:
 *     summary: Get a generic import job by id
 *     tags: [Import]
 *     responses:
 *       200:
 *         description: Job status payload
 *       403:
 *         description: Not authorized to view this job
 *       404:
 *         description: Import job not found
 */
router.get(
    "/jobs/:jobId",
    requireAuth,
    async (req: Request<{ jobId: string }>, res: Response) => {
        try {
            const job = await importJobStore.getJob(req.params.jobId);
            if (!job) {
                return res.status(404).json({ error: "Import job not found" });
            }
            if (job.userId !== req.user!.id) {
                return res
                    .status(403)
                    .json({ error: "Not authorized to view this import job" });
            }

            res.json({ job });
        } catch (err) {
            logger.error("[Import] Job status failed:", err);
            res.status(500).json({ error: "Failed to load import job" });
        }
    },
);

/**
 * @openapi
 * /api/import/jobs/reconnect:
 *   post:
 *     summary: Reconnect to an active generic import job by source URL
 *     tags: [Import]
 *     responses:
 *       200:
 *         description: Active generic import job
 *       404:
 *         description: No active job found for source
 */
router.post(
    "/jobs/reconnect",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const parsed = reconnectJobSchema.safeParse(req.body);
            if (!parsed.success) {
                return res
                    .status(400)
                    .json({ error: "Valid playlist URL is required" });
            }

            const parsedSource = playlistImportService.parseSourceUrl(
                parsed.data.url,
            );
            if (!parsedSource) {
                return res
                    .status(400)
                    .json({ error: "Unsupported playlist URL" });
            }

            const normalizedSource = buildNormalizedSource(
                parsedSource.source,
                parsedSource.id,
            );
            const job = await importJobStore.findActiveJobForSource(
                req.user!.id,
                normalizedSource,
            );

            if (!job) {
                return res
                    .status(404)
                    .json({ error: "No active import job found for source" });
            }

            res.json({ job });
        } catch (err) {
            logger.error("[Import] Job reconnect failed:", err);
            res.status(500).json({ error: "Failed to reconnect import job" });
        }
    },
);

/**
 * @openapi
 * /api/import/jobs/{jobId}/cancel:
 *   post:
 *     summary: Cancel an active generic import job
 *     tags: [Import]
 *     responses:
 *       200:
 *         description: Cancelled job payload
 *       403:
 *         description: Not authorized to cancel this job
 *       404:
 *         description: Import job not found
 *       409:
 *         description: Job already terminal
 */
router.post(
    "/jobs/:jobId/cancel",
    requireAuth,
    async (req: Request<{ jobId: string }>, res: Response) => {
        try {
            const cancellation = await importJobStore.requestCancellation(
                req.params.jobId,
                req.user!.id,
            );
            if (cancellation.outcome === "not_found") {
                return res.status(404).json({ error: "Import job not found" });
            }
            if (cancellation.outcome === "forbidden") {
                return res.status(403).json({
                    error: "Not authorized to cancel this import job",
                });
            }
            if (cancellation.outcome === "conflict") {
                return res.status(409).json({
                    error: `Import job already ${cancellation.job.status}`,
                });
            }

            const cancelledJob = cancellation.job;
            if (cancelledJob?.draftData) {
                genericImportJobRunner.enqueue(
                    cancelledJob.id,
                    cancelledJob.resolutionAttempt,
                    {
                        version: 1,
                        revision: cancelledJob.draftRevision!,
                        attempt: cancelledJob.resolutionAttempt,
                    },
                );
            }
            res.json({ job: cancellation.job });
        } catch (err) {
            logger.error("[Import] Job cancel failed:", err);
            res.status(500).json({ error: "Failed to cancel import job" });
        }
    },
);

/**
 * @openapi
 * /api/import/jobs/{jobId}/retry:
 *   post:
 *     summary: Retry unresolved positions in a settled background import
 *     tags: [Import]
 *     responses:
 *       200:
 *         description: Resolution retry started
 *       403:
 *         description: Not authorized to retry this job
 *       404:
 *         description: Import job not found
 *       409:
 *         description: Job has no retryable unresolved positions
 */
router.post(
    "/jobs/:jobId/retry",
    requireAuth,
    async (req: Request<{ jobId: string }>, res: Response) => {
        try {
            const retry = await importJobStore.requestResolutionRetry(
                req.params.jobId,
                req.user!.id,
            );
            if (retry.outcome === "not_found") {
                return res.status(404).json({ error: "Import job not found" });
            }
            if (retry.outcome === "forbidden") {
                return res.status(403).json({
                    error: "Not authorized to retry this import job",
                });
            }
            if (retry.outcome === "conflict") {
                return res.status(409).json({
                    error: "Import job has no retryable unresolved positions",
                });
            }
            if (!retry.job) {
                return res.status(409).json({
                    error: "Import job could not be retried",
                });
            }

            genericImportJobRunner.enqueue(
                retry.job.id,
                retry.job.resolutionAttempt,
            );
            res.json({ job: retry.job });
        } catch (err) {
            log.error("Job retry failed", { error: err });
            sendInternalRouteError(res, "Failed to retry import job");
        }
    },
);

const m3uPreviewSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    content: z.string().min(1),
});

const M3U_CONTENT_MAX_BYTES = 2_000_000;

/**
 * @openapi
 * /api/import/m3u/preview:
 *   post:
 *     summary: Preview an M3U/M3U8 playlist file import against the local library
 *     tags: [Import]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               name:
 *                 type: string
 *                 description: Playlist name (defaults to "M3U import")
 *               content:
 *                 type: string
 *                 description: Raw M3U/M3U8 file content
 *     responses:
 *       200:
 *         description: Track resolution preview with local-library matching
 *       400:
 *         description: Invalid or missing content
 *       401:
 *         description: Not authenticated
 */
router.post(
    "/m3u/preview",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const parsed = m3uPreviewSchema.safeParse(req.body);
            if (!parsed.success) {
                return res
                    .status(400)
                    .json({ error: "Playlist file content is required" });
            }

            if (parsed.data.content.length > M3U_CONTENT_MAX_BYTES) {
                return res
                    .status(400)
                    .json({ error: "Playlist file content is too large" });
            }

            const playlistName = parsed.data.name || "M3U import";
            const result = await playlistImportService.previewM3UImport(
                playlistName,
                parsed.data.content,
            );
            res.json(result);
        } catch (err: any) {
            logger.error("[Import] M3U preview failed:", err);
            res.status(500).json({ error: "Failed to preview M3U import" });
        }
    },
);

router.post("/preview", requireAuth, async (req: Request, res: Response) => {
    try {
        const parsed = urlSchema.safeParse(req.body);
        if (!parsed.success) {
            return res
                .status(400)
                .json({ error: "Valid playlist URL is required" });
        }

        const userId = req.user!.id;
        const result = await playlistImportService.previewImport(
            userId,
            parsed.data.url,
        );
        res.json(result);
    } catch (err: any) {
        const msg = err.message || "";
        if (
            msg.includes("Unsupported") ||
            msg.includes("not found") ||
            msg.includes("requires authentication")
        ) {
            return res.status(400).json({ error: msg });
        }
        if (
            msg.includes("ECONNREFUSED") ||
            msg.includes("ETIMEDOUT") ||
            msg.includes("fetch failed") ||
            msg.includes("status code 5")
        ) {
            logger.warn("[Import] External service unavailable:", err);
            return res
                .status(502)
                .json({ error: "External service unavailable" });
        }
        logger.error("[Import] Preview failed:", err);
        res.status(500).json({ error: "Failed to preview import" });
    }
});

/**
 * @openapi
 * /api/import/execute:
 *   post:
 *     summary: Execute playlist import — create playlist from preview data
 *     tags: [Import]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - previewData
 *             properties:
 *               previewData:
 *                 type: object
 *                 description: Preview data from /api/import/preview
 *                 properties:
 *                   playlistName:
 *                     type: string
 *                   resolved:
 *                     type: array
 *                     items:
 *                       type: object
 *                   summary:
 *                     type: object
 *               name:
 *                 type: string
 *                 description: Custom playlist name (uses source name if omitted)
 *     responses:
 *       200:
 *         description: Created playlist details
 *       400:
 *         description: Invalid request body
 *       401:
 *         description: Not authenticated
 */
router.post("/execute", requireAuth, async (req: Request, res: Response) => {
    try {
        const parsed = executeSchema.safeParse(req.body);
        if (!parsed.success) {
            return res
                .status(400)
                .json({ error: "Valid previewData is required" });
        }

        const userId = req.user!.id;
        const result = await playlistImportService.importPlaylist(
            userId,
            parsed.data.previewData,
            parsed.data.name,
        );
        res.json(result);
    } catch (err: any) {
        if (err.message?.includes("Invalid track reference")) {
            return res.status(400).json({ error: err.message });
        }
        logger.error("[Import] Execute failed:", err);
        res.status(500).json({ error: "Failed to execute import" });
    }
});

export default router;
