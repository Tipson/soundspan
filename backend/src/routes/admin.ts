import { Router } from "express";
import {
    generateQueueDashboardToken,
    requireAdmin,
    requireAuth,
    requireInteractiveSession,
    verifyAccessToken,
} from "../middleware/auth";
import {
    queueDashboardCookieName,
    queueDashboardCookieOptions,
    QUEUE_DASHBOARD_TTL_SECONDS,
    dashboardBindingCookieName,
    dashboardBindingCookieOptions,
    DASHBOARD_BINDING_TTL_SECONDS,
    readDashboardBinding,
    hashDashboardBearer,
} from "../middleware/queueDashboardCookie";
import { dashboardSessions } from "../utils/dashboardSessionState";
import { getDashboardRevocationContext } from "../utils/dashboardSessionContext";
import { randomBytes } from "node:crypto";
import { sendRouteError } from "../utils/routeErrorResponse";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    ENCRYPTED_SETTINGS_COLUMNS,
    isV2Envelope,
    type EncryptedModelName,
} from "../utils/encryptedColumns";
import { getPepperFingerprint, isHashedApiKey } from "../utils/apiKeyHash";
import { config } from "../config";
import {
    handlePurgeRemovedStatus,
    handlePurgeRemovedTracksNow,
} from "./adminLibraryHealthPurge";

const router = Router();

/**
 * @openapi
 * /api/admin/queues/binding:
 *   post:
 *     summary: Prepare a non-authenticating browser binding for the queue dashboard
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       204:
 *         description: Browser binding prepared; no dashboard credential is issued
 *       401:
 *         description: Interactive authentication required
 *       403:
 *         description: Administrator access required or too many active bindings
 *       503:
 *         description: Dashboard state unavailable
 */
router.post(
    "/queues/binding",
    requireInteractiveSession,
    requireAuth,
    requireAdmin,
    async (req, res) => {
        const header = req.headers.authorization;
        if (!req.user || !header?.startsWith("Bearer "))
            return sendRouteError(
                res,
                401,
                "Interactive authentication required",
            );
        let access: ReturnType<typeof verifyAccessToken>;
        try {
            access = verifyAccessToken(header.slice(7));
        } catch {
            return sendRouteError(
                res,
                401,
                "Interactive authentication required",
            );
        }
        if (typeof access.tokenVersion !== "number")
            return sendRouteError(
                res,
                401,
                "Interactive authentication required",
            );
        try {
            const previousId = readDashboardBinding(req, config.secureCookies);
            if (previousId) {
                const previous = await dashboardSessions.read(previousId);
                if (
                    previous?.ownerId === req.user.id &&
                    previous.tokenVersion === access.tokenVersion
                ) {
                    // Do not re-send a binding cookie: a delayed bootstrap must not
                    // restore an old binding after logout cleared the browser.
                    return res.status(204).end();
                }
                await dashboardSessions.revoke(previousId, null, false);
            }
            const bindingId = randomBytes(24).toString("hex");
            const created = await dashboardSessions.bootstrap(bindingId, {
                ownerId: req.user.id,
                tokenVersion: access.tokenVersion,
                epoch: randomBytes(24).toString("hex"),
                grantNonce: null,
                bearerHash: hashDashboardBearer(header.slice(7)),
            });
            if (!created)
                return sendRouteError(
                    res,
                    403,
                    "Dashboard binding limit reached; end dashboard access and retry",
                );
            res.cookie(
                dashboardBindingCookieName(config.secureCookies),
                bindingId,
                {
                    ...dashboardBindingCookieOptions(config.secureCookies),
                    maxAge: DASHBOARD_BINDING_TTL_SECONDS * 1000,
                },
            );
            res.setHeader("Cache-Control", "no-store");
            return res.status(204).end();
        } catch (error) {
            logger
                .child("QueueDashboard")
                .warn("Binding could not be created", error);
            return sendRouteError(
                res,
                503,
                "Dashboard session state unavailable",
            );
        }
    },
);

/**
 * @openapi
 * /api/admin/queues/session:
 *   post:
 *     summary: Create a short administrator session limited to the queue dashboard
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard cookie set; response contains expiresIn in seconds
 *       401:
 *         description: Interactive authentication required
 *       403:
 *         description: Administrator session required; API keys are not accepted
 *       503:
 *         description: Authentication backend unavailable
 */
router.post(
    "/queues/session",
    requireInteractiveSession,
    requireAuth,
    requireAdmin,
    async (req, res) => {
        if (!req.user || !req.headers.authorization?.startsWith("Bearer ")) {
            return sendRouteError(
                res,
                401,
                "Interactive authentication required",
            );
        }
        let access: ReturnType<typeof verifyAccessToken>;
        try {
            access = verifyAccessToken(req.headers.authorization.slice(7));
        } catch {
            return sendRouteError(
                res,
                401,
                "Interactive authentication required",
            );
        }
        try {
            const bindingId = readDashboardBinding(req, config.secureCookies);
            if (!bindingId)
                return sendRouteError(res, 401, "Dashboard binding required");
            const binding = await dashboardSessions.read(bindingId);
            if (
                !binding ||
                binding.ownerId !== req.user.id ||
                binding.tokenVersion !== access.tokenVersion
            ) {
                return sendRouteError(
                    res,
                    401,
                    "Dashboard binding expired; reopen the panel",
                );
            }
            const user = await prisma.user.findUnique({
                where: { id: req.user.id },
                select: {
                    id: true,
                    role: true,
                    tokenVersion: true,
                    pendingDeletionAt: true,
                },
            });
            if (
                !user ||
                user.role !== "admin" ||
                user.pendingDeletionAt ||
                access.userId !== user.id ||
                access.tokenVersion !== user.tokenVersion
            ) {
                return sendRouteError(res, 403, "Admin access required");
            }
            const nonce = randomBytes(24).toString("hex");
            const grantedNonce = await dashboardSessions.mint(
                bindingId,
                binding,
                nonce,
                hashDashboardBearer(req.headers.authorization.slice(7)),
            );
            if (!grantedNonce) {
                return sendRouteError(
                    res,
                    401,
                    "Dashboard access was ended; reopen the panel",
                );
            }
            res.cookie(
                queueDashboardCookieName(config.secureCookies),
                generateQueueDashboardToken(user, {
                    bindingId,
                    epoch: binding.epoch,
                    nonce: grantedNonce,
                }),
                {
                    ...queueDashboardCookieOptions(config.secureCookies),
                    maxAge: QUEUE_DASHBOARD_TTL_SECONDS * 1000,
                },
            );
            res.setHeader("Cache-Control", "no-store");
            return res.json({ expiresIn: QUEUE_DASHBOARD_TTL_SECONDS });
        } catch (error) {
            logger
                .child("QueueDashboard")
                .warn("Session could not be created", error);
            return sendRouteError(
                res,
                503,
                "Authentication service unavailable",
            );
        }
    },
);

/**
 * @openapi
 * /api/admin/queues/session:
 *   delete:
 *     summary: Clear the browser's queue dashboard session
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       204:
 *         description: Dashboard cookie cleared
 *       401:
 *         description: Interactive authentication required
 *       403:
 *         description: Administrator session required; API keys are not accepted
 */
router.delete(
    "/queues/session",
    requireInteractiveSession,
    requireAuth,
    requireAdmin,
    async (req, res) => {
        const context = getDashboardRevocationContext(
            req,
            config.secureCookies,
        );
        res.clearCookie(
            queueDashboardCookieName(config.secureCookies),
            queueDashboardCookieOptions(config.secureCookies),
        );
        res.clearCookie(
            dashboardBindingCookieName(config.secureCookies),
            dashboardBindingCookieOptions(config.secureCookies),
        );
        res.setHeader("Cache-Control", "no-store");
        try {
            await dashboardSessions.revoke(context.bindingId, null, false);
        } catch (error) {
            logger
                .child("QueueDashboard")
                .warn("Access could not be ended", error);
            return sendRouteError(
                res,
                503,
                "Dashboard session state unavailable",
            );
        }
        return res.status(204).end();
    },
);

// Bull Board is mounted separately after queue initialization. Only its prefix
// bypasses this router's ordinary bearer/API-key guard; its dedicated guard
// authenticates every HTML, asset and action request at the final mount.
router.use("/queues", (_req, _res, next) => next("router"));
router.use(requireAuth, requireAdmin);

// Per-model row fetchers for the secrets-status check. Keyed by the same model
// names as ENCRYPTED_SETTINGS_COLUMNS so the column inventory stays the single
// source of truth; the `select` is driven by that inventory at call time.
const ENCRYPTED_MODEL_QUERIERS: Record<
    EncryptedModelName,
    (select: Record<string, boolean>) => Promise<Array<Record<string, unknown>>>
> = {
    federationPeer: (select) => prisma.federationPeer.findMany({ select }),
    musicSourceConnection: (select) =>
        prisma.musicSourceConnection.findMany({ select }),
    user: (select) => prisma.user.findMany({ select }),
    userSettings: (select) => prisma.userSettings.findMany({ select }),
    systemSettings: (select) => prisma.systemSettings.findMany({ select }),
};

function isPrismaRecordNotFound(error: unknown): error is { code: string } {
    return Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2025",
    );
}

/**
 * @openapi
 * /api/admin/library-health:
 *   get:
 *     summary: List library health records
 *     tags: [Admin]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Library health records returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [records, total, removedPendingPurgeCount, trackRemovalRetentionDays]
 *               properties:
 *                 records:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       trackId:
 *                         type: string
 *                       status:
 *                         type: string
 *                         enum: [MISSING_FROM_DISK, UNREADABLE_METADATA]
 *                       filePath:
 *                         type: string
 *                       detail:
 *                         type: string
 *                         nullable: true
 *                       detectedAt:
 *                         type: string
 *                         format: date-time
 *                       updatedAt:
 *                         type: string
 *                         format: date-time
 *                       track:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           title:
 *                             type: string
 *                           removedAt:
 *                             type: string
 *                             format: date-time
 *                             nullable: true
 *                 total:
 *                   type: integer
 *                   minimum: 0
 *                 removedPendingPurgeCount:
 *                   type: integer
 *                   minimum: 0
 *                 trackRemovalRetentionDays:
 *                   type: integer
 *                   minimum: 0
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
router.get("/library-health", async (_req, res) => {
    try {
        const [records, total] = await Promise.all([
            prisma.libraryHealthRecord.findMany({
                include: {
                    track: {
                        select: {
                            id: true,
                            title: true,
                            removedAt: true,
                            album: {
                                select: {
                                    title: true,
                                    artist: {
                                        select: {
                                            name: true,
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                orderBy: {
                    updatedAt: "desc",
                },
            }),
            prisma.libraryHealthRecord.count(),
        ]);

        const removedPendingPurgeCount = records.filter(
            (record) =>
                record.status === "MISSING_FROM_DISK" &&
                record.track.removedAt !== null,
        ).length;

        res.json({
            records,
            total,
            removedPendingPurgeCount,
            trackRemovalRetentionDays: config.workers.trackRemovalRetentionDays,
        });
    } catch (error) {
        logger.error("Get library health error:", error);
        res.status(500).json({
            error: "Failed to load library health records",
        });
    }
});

/**
 * @openapi
 * /api/admin/library-health/purge-removed:
 *   post:
 *     summary: Immediately purge all soft-removed local tracks
 *     tags: [Admin]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Purge sweep enqueue result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [enqueued, matched]
 *               properties:
 *                 enqueued:
 *                   type: boolean
 *                 matched:
 *                   type: integer
 *                   minimum: 0
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Purge sweep could not be enqueued
 */
router.post("/library-health/purge-removed", handlePurgeRemovedTracksNow);

/**
 * @openapi
 * /api/admin/library-health/purge-status:
 *   get:
 *     summary: Report progress of the removed-track purge
 *     tags: [Admin]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Purge progress snapshot
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [remaining, purging]
 *               properties:
 *                 remaining:
 *                   type: integer
 *                   minimum: 0
 *                 purging:
 *                   type: boolean
 *                 lastFailure:
 *                   type: string
 *                   nullable: true
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Purge status could not be read
 */
router.get("/library-health/purge-status", handlePurgeRemovedStatus);

/**
 * @openapi
 * /api/admin/library-health/{recordId}:
 *   delete:
 *     summary: Dismiss a library health record
 *     tags: [Admin]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: recordId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Record dismissed successfully
 *       404:
 *         description: Library health record not found
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
router.delete("/library-health/:recordId", async (req, res) => {
    try {
        await prisma.libraryHealthRecord.delete({
            where: {
                id: req.params.recordId,
            },
        });

        res.json({ success: true });
    } catch (error) {
        if (isPrismaRecordNotFound(error)) {
            return res
                .status(404)
                .json({ error: "Library health record not found" });
        }

        logger.error("Dismiss library health record error:", error);
        res.status(500).json({
            error: "Failed to dismiss library health record",
        });
    }
});

/**
 * @openapi
 * /api/admin/secrets-status:
 *   get:
 *     summary: Report settings-cipher migration progress (legacy v1 vs authenticated v2)
 *     tags: [Admin]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Counts of encrypted settings values still on the legacy cipher vs migrated to v2
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Not an admin
 */
// GET /admin/secrets-status - how many encrypted settings columns are still on
// the legacy v1 (AES-256-CBC) cipher vs migrated to authenticated v2 GCM. Lets
// an operator know when the v1→v2 backfill is complete (legacy === 0) and it's
// safe to drop the legacy read path. Returns only counts — never secret values.
router.get("/secrets-status", async (_req, res) => {
    try {
        const byModel: Record<
            string,
            { total: number; v2: number; legacy: number }
        > = {};
        let total = 0;
        let v2 = 0;
        let legacy = 0;

        for (const [modelName, columns] of Object.entries(
            ENCRYPTED_SETTINGS_COLUMNS,
        )) {
            const select: Record<string, boolean> = {};
            for (const column of columns) select[column] = true;

            const rows =
                await ENCRYPTED_MODEL_QUERIERS[modelName as EncryptedModelName](
                    select,
                );

            let modelV2 = 0;
            let modelLegacy = 0;
            for (const row of rows) {
                for (const column of columns) {
                    const value = row[column];
                    if (typeof value !== "string" || value.length === 0) {
                        continue;
                    }
                    if (isV2Envelope(value)) modelV2 += 1;
                    else modelLegacy += 1;
                }
            }

            byModel[modelName] = {
                total: modelV2 + modelLegacy,
                v2: modelV2,
                legacy: modelLegacy,
            };
            total += modelV2 + modelLegacy;
            v2 += modelV2;
            legacy += modelLegacy;
        }

        // API keys at rest: hashed (hmac:<hex>) vs legacy plaintext rows.
        const apiKeyRows = await prisma.apiKey.findMany({
            select: { key: true },
        });
        let apiKeysHashed = 0;
        let apiKeysPlaintext = 0;
        for (const row of apiKeyRows) {
            if (isHashedApiKey(row.key)) apiKeysHashed += 1;
            else apiKeysPlaintext += 1;
        }

        res.json({
            settingsCipher: {
                total,
                v2,
                legacy,
                migrationComplete: legacy === 0,
                byModel,
            },
            apiKeys: {
                total: apiKeysHashed + apiKeysPlaintext,
                hashed: apiKeysHashed,
                plaintext: apiKeysPlaintext,
                migrationComplete: apiKeysPlaintext === 0,
                // Fingerprint of the pepper VALUE (not the value itself) —
                // compare with the hash-existing-api-keys backfill log to
                // catch a script-env vs app-env mismatch before --apply.
                pepperFingerprint: getPepperFingerprint(),
            },
        });
    } catch (error) {
        logger.error("Secrets status error:", error);
        res.status(500).json({ error: "Failed to compute secrets status" });
    }
});

export default router;
