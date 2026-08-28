import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuthOrToken } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { personalizedCatalogService } from "../services/personalizedCatalog";
import { logger } from "../utils/logger";
import { sendRouteError } from "../utils/routeErrorResponse";

const router = Router();
const log = logger.child("PersonalizedHome");
const DEFAULT_SHELF_LIMIT = 12;
const personalizedHomeQuerySchema = z
    .object({
        limit: z
            .string()
            .regex(/^[1-9]\d*$/)
            .transform(Number)
            .pipe(z.number().int().min(1).max(25))
            .optional(),
        token: z.string().optional(),
    })
    .strict();

router.use(requireAuthOrToken);

/**
 * @openapi
 * components:
 *   schemas:
 *     PersonalizedTrack:
 *       type: object
 *       required: [id, title, duration, trackNo, artist, album, source, streamSource, youtubeVideoId, provider]
 *       properties:
 *         id:
 *           type: string
 *           example: yt:dQw4w9WgXcQ
 *         title:
 *           type: string
 *         duration:
 *           type: integer
 *           minimum: 0
 *         trackNo:
 *           type: integer
 *           nullable: true
 *         artist:
 *           type: object
 *           required: [id, name]
 *           properties:
 *             id:
 *               type: string
 *               nullable: true
 *             name:
 *               type: string
 *         album:
 *           type: object
 *           required: [id, title, coverArt, artist]
 *           properties:
 *             id:
 *               type: string
 *               nullable: true
 *             title:
 *               type: string
 *             coverArt:
 *               type: string
 *             artist:
 *               type: object
 *               required: [id, name]
 *               properties:
 *                 id:
 *                   type: string
 *                   nullable: true
 *                 name:
 *                   type: string
 *         source:
 *           type: string
 *           enum: [youtube]
 *         streamSource:
 *           type: string
 *           enum: [youtube]
 *         youtubeVideoId:
 *           type: string
 *         provider:
 *           type: object
 *           required: [tidalTrackId, youtubeVideoId]
 *           properties:
 *             tidalTrackId:
 *               type: integer
 *               nullable: true
 *             youtubeVideoId:
 *               type: string
 *     PersonalizedHomeFeed:
 *       type: object
 *       required: [shelves, degraded, reason, seedCount]
 *       properties:
 *         shelves:
 *           type: object
 *           required: [listenAgain, quickPicks, discovery]
 *           properties:
 *             listenAgain:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/PersonalizedTrack'
 *             quickPicks:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/PersonalizedTrack'
 *             discovery:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/PersonalizedTrack'
 *         degraded:
 *           type: boolean
 *         reason:
 *           type: string
 *           nullable: true
 *           enum: [insufficient_signals, provider_partial_failure, provider_unavailable]
 *         seedCount:
 *           type: integer
 *           minimum: 0
 *           maximum: 3
 */

/**
 * @openapi
 * /api/personalized/home:
 *   get:
 *     summary: Get personalized, directly playable YouTube Music shelves
 *     tags: [Personalized]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 25
 *           default: 12
 *         description: Maximum number of tracks returned in each shelf
 *     responses:
 *       200:
 *         description: Personalized remote-only home shelves
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PersonalizedHomeFeed'
 *       400:
 *         description: Invalid query
 *       401:
 *         description: Not authenticated
 */
async function handlePersonalizedHome(req: Request, res: Response) {
    const parsedQuery = personalizedHomeQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
        return sendRouteError(
            res,
            400,
            "Invalid personalized home feed query",
            { code: "INVALID_QUERY" },
        );
    }

    const userId = req.user?.id;
    if (!userId) {
        return sendRouteError(res, 401, "Authentication required", {
            code: "AUTH_REQUIRED",
        });
    }

    const feed = await personalizedCatalogService.getHomeFeed(
        userId,
        parsedQuery.data.limit ?? DEFAULT_SHELF_LIMIT,
    );
    if (feed.degraded) {
        log.warn("Personalized home feed returned degraded provider results", {
            reason: feed.reason,
            seedCount: feed.seedCount,
        });
    }
    return res.json(feed);
}

router.get("/home", asyncHandler(handlePersonalizedHome));

export default router;
