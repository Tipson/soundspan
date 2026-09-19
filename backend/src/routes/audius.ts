import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../config";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { audiusService, AudiusError } from "../services/audius";
import { logger } from "../utils/logger";
import { sendRouteError } from "../utils/routeErrorResponse";
import { createStreamProxyRequestAbort } from "./streamProxyRequestAbort";

const router = Router();
const log = logger.child("Audius");
const searchSchema = z.object({
    query: z.string().trim().min(1).max(200),
    limit: z
        .string()
        .regex(/^(?:[1-9]|1[0-9]|20)$/)
        .optional(),
});
const idSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9]{3,32}$/) });

router.use(requireAuth);
router.use((_req, res, next) => {
    if (!config.features.audius)
        return sendRouteError(res, 404, "Audius is not enabled");
    res.setHeader("Cache-Control", "no-store");
    next();
});
router.use(
    rateLimit({
        windowMs: 60_000,
        limit: 60,
        keyGenerator: (req) => req.user!.id,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res) =>
            sendRouteError(res, 429, "Too many Audius requests"),
    }),
);

async function run(
    req: Request,
    res: Response,
    operation: (signal: AbortSignal) => Promise<unknown>,
) {
    const lifetime = createStreamProxyRequestAbort(req, res);
    try {
        if (lifetime.wasClientAborted()) return;
        const result = await operation(lifetime.signal);
        if (!lifetime.wasClientAborted()) res.json(result);
    } catch (error) {
        if (lifetime.wasClientAborted()) return;
        if (error instanceof AudiusError) {
            if (error.status === 503) res.setHeader("Retry-After", "30");
            return sendRouteError(res, error.status, error.message);
        }
        // No raw upstream error/config logging: those may contain private headers.
        log.warn("Audius metadata request failed");
        return sendRouteError(res, 502, "Audius is temporarily unavailable");
    } finally {
        lifetime.dispose();
    }
}

/**
 * @openapi
 * /api/audius/search:
 *   get:
 *     summary: Search the opt-in Audius independent music catalog
 *     tags: [Audius]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: query
 *         required: true
 *         schema: { type: string, minLength: 1, maxLength: 200 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 20, default: 10 }
 *     responses:
 *       200: { description: Source-labelled fully streamable tracks with attribution }
 *       400: { description: Invalid query }
 *       401: { description: Authentication required }
 *       404: { description: Audius feature disabled }
 *       429: { description: Account rate limit reached }
 *       502: { description: Invalid or unavailable provider response }
 *       503: { description: Provider concurrency or cooldown limit reached }
 */
router.get(
    "/search",
    asyncHandler(async (req, res) => {
        const parsed = searchSchema.safeParse(req.query);
        if (!parsed.success)
            return sendRouteError(res, 400, "Invalid Audius search query");
        return run(req, res, async (signal) => ({
            source: "audius",
            tracks: await audiusService.search(
                parsed.data.query,
                Number(parsed.data.limit ?? 10),
                signal,
            ),
        }));
    }),
);

/**
 * @openapi
 * /api/audius/tracks/{id}/playback:
 *   get:
 *     summary: Revalidate full Audius access and resolve a public playback URL
 *     description: Returns JSON, never an authenticated redirect. Use streamUrl without Soundspan credentials. Does not grant download or cross-provider replacement rights.
 *     tags: [Audius]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, pattern: '^[A-Za-z0-9]{3,32}$' }
 *     responses:
 *       200: { description: Audius source and official HTTPS streamUrl }
 *       400: { description: Invalid track id }
 *       401: { description: Authentication required }
 *       404: { description: Feature disabled or track absent }
 *       422: { description: Full public stream unavailable }
 *       429: { description: Account rate limit reached }
 *       502: { description: Invalid or unavailable provider response }
 *       503: { description: Provider concurrency or cooldown limit reached }
 */
router.get(
    "/tracks/:id/playback",
    asyncHandler(async (req, res) => {
        const parsed = idSchema.safeParse(req.params);
        if (!parsed.success)
            return sendRouteError(res, 400, "Invalid Audius track id");
        return run(req, res, async (signal) => ({
            source: "audius",
            streamUrl: await audiusService.resolveStream(
                parsed.data.id,
                signal,
            ),
            trackId: parsed.data.id,
        }));
    }),
);

export default router;
