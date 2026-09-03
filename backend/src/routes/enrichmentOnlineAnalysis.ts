import { Router } from "express";
import { requireAdmin } from "../middleware/auth";
import { getOnlineAnalysisProgress } from "../services/recommendations/onlineAnalysisProgress";
import { logger } from "../utils/logger";
import { sendRouteFailure } from "../utils/routeErrorResponse";

const router = Router();
const log = logger.child("OnlineAnalysisProgress");

/**
 * @openapi
 * /api/enrichment/online-analysis:
 *   get:
 *     summary: Read administrator-only shared canonical audio analysis coverage
 *     tags: [Enrichment]
 *     responses:
 *       '200':
 *         description: Thirty-second snapshot of canonical totals, scalar coverage, active-space vector coverage, live asset leases and configured admission quota. Remaining includes failed and unscheduled recordings; checkedToday includes denied reservations, not successful analyses. Embeddings is null without an active space; checkedToday is null when Redis telemetry is unavailable.
 *       '401':
 *         description: Authentication required
 *       '403':
 *         description: Administrator required
 *       '500':
 *         description: Analysis counters unavailable
 */
router.get("/", requireAdmin, async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
        res.json(await getOnlineAnalysisProgress());
    } catch (error) {
        sendRouteFailure(
            res,
            log,
            [
                "Analysis counters unavailable",
                "Failed to load online analysis progress",
            ],
            error,
        );
    }
});

export default router;
