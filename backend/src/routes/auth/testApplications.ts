import type { Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../../middleware/auth";
import { adminSurfaceLimiter } from "../../middleware/rateLimiter";
import { createRedisRateLimitOptions } from "../../middleware/rateLimitStore";
import { logger } from "../../utils/logger";
import { sendRouteError } from "../../utils/routeErrorResponse";
import {
    TestApplicationError,
    submitTestApplication,
    listTestApplications,
    approveTestApplication,
} from "../../services/testApplications";

const log = logger.child("TestApplications");
const submissionLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
    ...createRedisRateLimitOptions("test-applications", { fallback: "memory" }),
    handler: (_req, res) => {
        res.status(429).json({
            error: "Слишком много заявок. Попробуйте позже.",
        });
    },
});
const identifier = z.string().min(1).max(128);
function failure(res: Response, error: unknown): void {
    if (error instanceof TestApplicationError) {
        sendRouteError(res, error.status, error.message);
        return;
    }
    if (error instanceof z.ZodError) {
        sendRouteError(res, 400, "Некорректный запрос.");
        return;
    }
    log.error("Testing application operation failed", { error });
    sendRouteError(
        res,
        500,
        "Не удалось сохранить или загрузить заявку. Попробуйте ещё раз.",
    );
}

/** Registers public submission and protected administrator approval for testing access. */
export default function registerTestApplicationRoutes(router: Router): void {
    /**
     * @openapi
     * /api/auth/test-applications:
     *   post:
     *     summary: Submit a testing application without creating an account
     *     tags: [Authentication]
     *     security: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [telegram]
     *             properties:
     *               telegram: { type: string, maxLength: 80 }
     *               device: { type: string, enum: ['', android, iphone, desktop, multiple] }
     *               website: { type: string, maxLength: 0 }
     *     responses:
     *       201: { description: Saved or already submitted; no invitation details are returned }
     *       400: { description: Invalid contact or device }
     *       415: { description: JSON required }
     *       429: { description: Submission rate exceeded }
     *       500: { description: Storage unavailable; application not acknowledged }
     *   get:
     *     summary: List testing applications and registration status for administrators
     *     tags: [Authentication]
     *     security: [{ apiKeyAuth: [] }]
     *     parameters:
     *       - in: query
     *         name: cursor
     *         schema: { type: string, maxLength: 128 }
     *     responses:
     *       200: { description: Up to 50 applications and optional nextCursor }
     *       401: { description: Authentication required }
     *       403: { description: Administrator required }
     */
    router.post("/test-applications", submissionLimiter, async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        if (!req.is("application/json")) {
            sendRouteError(res, 415, "Ожидается JSON.");
            return;
        }
        try {
            await submitTestApplication(req.body);
            res.status(201).json({ ok: true });
        } catch (error) {
            failure(res, error);
        }
    });
    router.get(
        "/test-applications",
        adminSurfaceLimiter,
        requireAuth,
        requireAdmin,
        async (req, res) => {
            res.setHeader("Cache-Control", "no-store");
            try {
                res.json(
                    await listTestApplications(
                        identifier.optional().parse(req.query.cursor),
                    ),
                );
            } catch (error) {
                failure(res, error);
            }
        },
    );
    /**
     * @openapi
     * /api/auth/test-applications/{id}/approve:
     *   post:
     *     summary: Approve once and obtain a single-use registration link
     *     tags: [Authentication]
     *     security: [{ apiKeyAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string, maxLength: 128 }
     *     responses:
     *       200: { description: Approved application; retries preserve the original invitation }
     *       401: { description: Authentication required }
     *       403: { description: Administrator required }
     *       404: { description: Application not found }
     */
    router.post(
        "/test-applications/:id/approve",
        adminSurfaceLimiter,
        requireAuth,
        requireAdmin,
        async (req, res) => {
            res.setHeader("Cache-Control", "no-store");
            try {
                res.json(
                    await approveTestApplication(
                        identifier.parse(req.params.id),
                        req.user!.id,
                    ),
                );
            } catch (error) {
                failure(res, error);
            }
        },
    );
}
