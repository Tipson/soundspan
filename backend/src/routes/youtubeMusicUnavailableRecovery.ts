import {
    Router,
    type NextFunction,
    type Request,
    type Response,
} from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { ytMusicSearchLimiter } from "../middleware/rateLimiter";
import { validate } from "../middleware/validate";
import { ytMusicUnavailableRecoveryService } from "../services/ytMusicUnavailableRecovery";
import { logger } from "../utils/logger";
import { sendInternalRouteError } from "../utils/routeErrorResponse";
import { getSystemSettings } from "../utils/systemSettings";

const videoIdSchema = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{11}$/);
const recoverySchema = z
    .object({
        originalVideoId: videoIdSchema,
        artist: z.string().trim().min(1).max(300),
        title: z.string().trim().min(1).max(500),
        albumTitle: z.string().trim().min(1).max(500).optional(),
        duration: z
            .number()
            .finite()
            .positive()
            .max(6 * 60 * 60)
            .optional(),
        excludedVideoIds: z.array(videoIdSchema).max(8).optional(),
        playlistItemId: z.string().trim().min(1).max(128).optional(),
        expectedTrackYtMusicId: z.string().trim().min(1).max(128).optional(),
    })
    .refine(
        (value) =>
            Boolean(value.playlistItemId) ===
            Boolean(value.expectedTrackYtMusicId),
        {
            message:
                "playlistItemId and expectedTrackYtMusicId must be provided together",
        },
    );

async function requireYtMusicEnabled(
    _req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        const settings = await getSystemSettings();
        if (!settings.ytMusicEnabled) {
            return res
                .status(403)
                .json({ error: "YouTube Music integration is not enabled" });
        }
        next();
    } catch (error) {
        logger.error("[YTMusic Recovery Route] Settings check failed:", error);
        sendInternalRouteError(res, "Internal server error");
    }
}

const router = Router();

/**
 * @openapi
 * /api/ytmusic/recover-unavailable:
 *   post:
 *     summary: Replace an unavailable YouTube Music identity with a validated exact candidate
 *     tags: [YouTube Music]
 *     responses:
 *       200:
 *         description: Original availability or validated replacement result
 *       400:
 *         description: Invalid recovery request
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: YouTube Music integration is not enabled
 */
router.post(
    "/recover-unavailable",
    requireAuth,
    requireYtMusicEnabled,
    ytMusicSearchLimiter,
    validate({ body: recoverySchema }),
    asyncHandler(async (req: Request, res: Response) => {
        const parsed = recoverySchema.safeParse(req.valid?.body ?? req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: "Invalid recovery request" });
        }
        try {
            res.json(
                await ytMusicUnavailableRecoveryService.recover(
                    req.user!.id,
                    parsed.data,
                ),
            );
        } catch (error) {
            logger.error("[YTMusic Recovery Route] Recovery failed:", error);
            sendInternalRouteError(
                res,
                "Failed to recover unavailable YouTube Music track",
            );
        }
    }),
);

export default router;
