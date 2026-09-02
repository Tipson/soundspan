import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuthOrToken } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { unifiedRecommendationService } from "../services/recommendations/recommendationRuntime";
import { recommendationExposureStore } from "../services/recommendations/exposureStore";
import { logger } from "../utils/logger";
import { sendRouteError } from "../utils/routeErrorResponse";

const router = Router();
const log = logger.child("PersonalizedHome");
const DEFAULT_SHELF_LIMIT = 12;
const MAX_CONTINUATION_EXCLUSIONS = 80;
const PROVIDER_VIDEO_ID_PATTERN = /^(?:yt:)?[A-Za-z0-9_-]{1,64}$/;
const personalizedHomeQuerySchema = z
    .object({
        limit: z
            .string()
            .regex(/^[1-9]\d*$/)
            .transform(Number)
            .pipe(z.number().int().min(1).max(25))
            .optional(),
        token: z.string().optional(),
        cursor: z
            .string()
            .regex(/^(?:0|[1-9]\d*)$/)
            .transform(Number)
            .pipe(z.number().int().min(0).max(1_000_000))
            .optional(),
        exclude: z.string().max(5_280).optional(),
        mode: z.enum(["for-you", "new", "familiar"]).optional(),
        mood: z
            .enum([
                "calm",
                "energetic",
                "focus",
                "workout",
                "favorites",
                "forgotten",
            ])
            .optional(),
        surface: z.enum(["home", "wave", "made-for-you"]).optional(),
        sessionId: z.string().trim().min(1).max(128).optional(),
        localHour: z.coerce.number().int().min(0).max(23).optional(),
        timezoneOffsetMinutes: z.coerce
            .number()
            .int()
            .min(-840)
            .max(840)
            .optional(),
        deviceClass: z.enum(["mobile", "tablet", "desktop", "tv"]).optional(),
    })
    .strict();
const recommendationImpressionsSchema = z
    .object({
        generationId: z.string().trim().min(1).max(128),
        tracks: z
            .array(
                z
                    .object({
                        provider: z.enum(["youtube", "tidal", "library"]),
                        providerTrackId: z.string().trim().min(1).max(128),
                    })
                    .strict(),
            )
            .min(1)
            .max(100),
    })
    .strict();

function parseContinuationExclusions(value: string | undefined): string[] {
    if (!value) return [];
    const videoIds = Array.from(
        new Set(
            value
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean)
                .map((entry) =>
                    entry.startsWith("yt:") ? entry.slice(3) : entry,
                ),
        ),
    );
    if (
        videoIds.length > MAX_CONTINUATION_EXCLUSIONS ||
        videoIds.some((videoId) => !PROVIDER_VIDEO_ID_PATTERN.test(videoId))
    ) {
        throw new TypeError("Invalid personalized continuation exclusions");
    }
    return videoIds;
}

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
 *       required: [shelves, degraded, reason, seedCount, nextCursor]
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
 *         nextCursor:
 *           type: integer
 *           minimum: 0
 *           description: Cursor for a fresh provider-radio seed page
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
 *       - in: query
 *         name: mode
 *         schema:
 *           type: string
 *           enum: [for-you, new, familiar]
 *           default: for-you
 *         description: Deterministic Wave ranking policy
 *       - in: query
 *         name: mood
 *         schema:
 *           type: string
 *           enum: [calm, energetic, focus, workout, favorites, forgotten]
 *         description: Independent mood or listening context applied to the Wave ranking policy
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: integer
 *           minimum: 0
 *         description: Rotates the bounded set of recommendation seeds for queue continuation
 *       - in: query
 *         name: exclude
 *         schema:
 *           type: string
 *         description: Up to 80 comma-separated YouTube video IDs already present in the queue
 *       - in: query
 *         name: localHour
 *         schema:
 *           type: integer
 *           minimum: 0
 *           maximum: 23
 *         description: Local clock hour used for account context learning
 *       - in: query
 *         name: timezoneOffsetMinutes
 *         schema:
 *           type: integer
 *           minimum: -840
 *           maximum: 840
 *         description: Client timezone offset from UTC in minutes
 *       - in: query
 *         name: deviceClass
 *         schema:
 *           type: string
 *           enum: [mobile, tablet, desktop, tv]
 *         description: Coarse client device class used for account context learning
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

    let excludeVideoIds: string[];
    try {
        excludeVideoIds = parseContinuationExclusions(parsedQuery.data.exclude);
    } catch {
        return sendRouteError(
            res,
            400,
            "Invalid personalized home feed query",
            { code: "INVALID_QUERY" },
        );
    }
    const limit = parsedQuery.data.limit ?? DEFAULT_SHELF_LIMIT;
    const feed = await unifiedRecommendationService.getPersonalizedFeed({
        userId,
        sessionId: parsedQuery.data.sessionId ?? randomUUID(),
        surface: parsedQuery.data.surface ?? "home",
        limit,
        cursor: parsedQuery.data.cursor ?? 0,
        direction: parsedQuery.data.mode ?? "for-you",
        mood: parsedQuery.data.mood ?? null,
        excludeVideoIds,
        context:
            parsedQuery.data.localHour === undefined &&
            parsedQuery.data.timezoneOffsetMinutes === undefined &&
            parsedQuery.data.deviceClass === undefined
                ? undefined
                : {
                      localHour: parsedQuery.data.localHour,
                      timezoneOffsetMinutes:
                          parsedQuery.data.timezoneOffsetMinutes,
                      deviceClass: parsedQuery.data.deviceClass,
                  },
    });
    if (feed.degraded) {
        log.warn("Personalized home feed returned degraded provider results", {
            reason: feed.reason,
            seedCount: feed.seedCount,
        });
    }
    return res.json(feed);
}

router.get("/home", asyncHandler(handlePersonalizedHome));

/**
 * @openapi
 * /api/personalized/impressions:
 *   post:
 *     summary: Record recommendation cards that entered the viewport
 *     tags: [Personalized]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [generationId, tracks]
 *             properties:
 *               generationId:
 *                 type: string
 *               tracks:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 100
 *                 items:
 *                   type: object
 *                   required: [provider, providerTrackId]
 *                   properties:
 *                     provider:
 *                       type: string
 *                       enum: [youtube, tidal, library]
 *                     providerTrackId:
 *                       type: string
 *     responses:
 *       200:
 *         description: Number of account-owned recommendation rows marked viewed
 *       400:
 *         description: Invalid impression batch
 *       401:
 *         description: Not authenticated
 */
router.post(
    "/impressions",
    asyncHandler(async (req, res) => {
        const parsed = recommendationImpressionsSchema.safeParse(req.body);
        if (!parsed.success) {
            return sendRouteError(
                res,
                400,
                "Invalid recommendation impressions",
                {
                    code: "INVALID_IMPRESSIONS",
                },
            );
        }
        const userId = req.user?.id;
        if (!userId) {
            return sendRouteError(res, 401, "Authentication required", {
                code: "AUTH_REQUIRED",
            });
        }
        const recorded = await recommendationExposureStore.markViewed({
            userId,
            generationId: parsed.data.generationId,
            viewedAt: new Date(),
            tracks: parsed.data.tracks,
        });
        return res.json({ recorded });
    }),
);

export default router;
