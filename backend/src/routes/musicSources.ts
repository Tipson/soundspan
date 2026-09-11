import { Router, type Request, type Response } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import {
    requireAuth,
    requireAuthOrToken,
    requireAdmin,
} from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { sendRouteError } from "../utils/routeErrorResponse";
import {
    listMusicSourceConnections,
    saveMusicSourceConnection,
    loadMusicSourceAdapters,
} from "../services/musicSources/connections";
import { musicSourceResolver } from "../services/musicSources/runtime";
import { MusicSourceError } from "../services/musicSources/types";
import { createStreamProxyRequestAbort } from "./streamProxyRequestAbort";

const router = Router();
const sourceSchema = z.enum(["yandex", "vk"]);
const updateSchema = z
    .object({
        token: z.string().min(8).max(8192).regex(/^\S+$/).optional(),
        enabled: z.boolean(),
    })
    .strict();
const recordingSchema = z
    .object({
        title: z.string().trim().min(1).max(200),
        artists: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
        duration: z.number().positive().max(3600),
        contentVersion: z.enum(["explicit", "clean", "unknown"]),
        isrc: z
            .string()
            .regex(/^[A-Za-z]{2}[A-Za-z0-9]{3}\d{7}$/)
            .optional(),
    })
    .strict();

function report(res: Response, error: unknown) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    const code = error instanceof MusicSourceError ? error.code : "unavailable";
    const status =
        code === "not_found"
            ? 404
            : code === "lease_expired"
              ? 410
              : code === "invalid_request"
                ? 400
                : ["auth_required", "entitlement_required"].includes(code)
                  ? 424
                  : code === "unsupported_stream"
                    ? 422
                    : 503;
    if (status === 503)
        res.setHeader(
            "Retry-After",
            String(
                error instanceof MusicSourceError
                    ? Math.max(1, Math.min(900, error.retryAfter))
                    : 30,
            ),
        );
    sendRouteError(res, status, code);
}
async function jsonOperation(
    req: Request,
    res: Response,
    run: (signal: AbortSignal) => Promise<unknown>,
) {
    const lifetime = createStreamProxyRequestAbort(req, res);
    try {
        res.setHeader("Cache-Control", "no-store");
        if (lifetime.wasClientAborted()) return;
        const result = await run(lifetime.signal);
        if (!lifetime.wasClientAborted()) res.json(result);
    } catch (error) {
        if (!lifetime.wasClientAborted()) report(res, error);
    } finally {
        lifetime.dispose();
    }
}
router.use(requireAuthOrToken);
router.use(
    rateLimit({
        windowMs: 60_000,
        limit: 90,
        keyGenerator: (req) => req.user!.id,
        standardHeaders: true,
        legacyHeaders: false,
    }),
);

/**
 * @openapi
 * /api/music-sources/connections:
 *   get:
 *     summary: Inspect redacted server music connections as an administrator
 *     tags: [Admin]
 *     responses:
 *       200: { description: Connection state and bounded runtime health }
 *       401: { description: Authentication required }
 *       403: { description: Administrator required }
 */
router.get(
    "/connections",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) =>
        jsonOperation(req, res, async () => ({
            connections: await listMusicSourceConnections(),
            health: musicSourceResolver.health(),
        })),
    ),
);

/**
 * @openapi
 * /api/music-sources/connections/{provider}:
 *   put:
 *     summary: Store encrypted server credentials or enable and disable a connection
 *     tags: [Admin]
 *     responses:
 *       200: { description: Saved without returning credentials }
 *       400: { description: Invalid connection settings }
 *       401: { description: Authentication required }
 *       403: { description: Administrator required }
 *       424: { description: Credentials required before enabling }
 */
router.put(
    "/connections/:provider",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const provider = sourceSchema.safeParse(req.params.provider),
            input = updateSchema.safeParse(req.body);
        if (!provider.success || !input.success)
            return sendRouteError(res, 400, "invalid_request");
        await jsonOperation(req, res, async () => {
            await saveMusicSourceConnection(provider.data, input.data);
            musicSourceResolver.revokeProvider(provider.data);
            return { saved: true };
        });
    }),
);

/**
 * @openapi
 * /api/music-sources/search:
 *   get:
 *     summary: Test enabled server catalog connections as an administrator
 *     tags: [Admin]
 *     responses:
 *       200: { description: Sanitized candidates from the selected provider }
 *       400: { description: Invalid search }
 *       403: { description: Administrator required }
 */
router.get(
    "/search",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const parsed = z
            .object({
                provider: sourceSchema,
                query: z.string().trim().min(1).max(200),
            })
            .safeParse(req.query);
        if (!parsed.success) return sendRouteError(res, 400, "invalid_request");
        await jsonOperation(req, res, async (signal) => {
            const source = (await loadMusicSourceAdapters()).find(
                (s) => s.provider === parsed.data.provider,
            );
            if (!source) throw new MusicSourceError("auth_required");
            return { tracks: await source.search(parsed.data.query, signal) };
        });
    }),
);

/**
 * @openapi
 * /api/music-sources/resolve:
 *   post:
 *     summary: Resolve an exact recording to a user-bound same-origin playback lease
 *     tags: [Streaming]
 *     responses:
 *       200: { description: Opaque playback lease or no exact candidate }
 *       400: { description: Invalid recording }
 *       401: { description: Authentication required }
 *       503: { description: Source budget or deadline exceeded }
 */
router.post(
    "/resolve",
    asyncHandler(async (req, res) => {
        const parsed = recordingSchema
            .extend({ provider: sourceSchema.optional() })
            .safeParse(req.body);
        if (!parsed.success) return sendRouteError(res, 400, "invalid_request");
        await jsonOperation(req, res, async (signal) => ({
            playback: await musicSourceResolver.resolve(
                req.user!.id,
                parsed.data,
                signal,
                parsed.data.provider,
            ),
        }));
    }),
);

/**
 * @openapi
 * /api/music-sources/leases/{id}/stream:
 *   get:
 *     summary: Stream an owned music lease with byte ranges and cancellation
 *     tags: [Streaming]
 *     responses:
 *       200: { description: Complete audio representation }
 *       206: { description: Partial audio representation }
 *       401: { description: Authentication required }
 *       404: { description: Unknown or unowned lease }
 *       410: { description: Expired lease or revoked credential generation }
 *       416: { description: Unsatisfiable byte range }
 *       503: { description: Temporarily unavailable source }
 *   head:
 *     summary: Inspect an owned audio representation without transferring its body
 *     tags: [Streaming]
 *     responses:
 *       200: { description: Representation headers }
 *       401: { description: Authentication required }
 *       404: { description: Unknown or unowned lease }
 */
router.get(
    "/leases/:id/stream",
    asyncHandler(async (req, res) => {
        if (
            typeof req.params.id !== "string" ||
            !/^[a-f0-9]{48}$/.test(req.params.id)
        )
            return sendRouteError(res, 404, "not_found");
        const lifetime = createStreamProxyRequestAbort(req, res);
        try {
            const response = await musicSourceResolver.open(
                req.user!.id,
                req.params.id,
                {
                    range: req.headers.range,
                    ifRange:
                        typeof req.headers["if-range"] === "string"
                            ? req.headers["if-range"]
                            : undefined,
                    head: req.method === "HEAD",
                },
                lifetime.signal,
            );
            if (lifetime.wasClientAborted()) {
                response.data.destroy();
                return;
            }
            res.status(response.status)
                .set(response.headers)
                .set("Cache-Control", "private, no-store");
            const finish = () => {
                response.data.destroy();
                lifetime.dispose();
            };
            res.once("close", finish).once("finish", finish);
            response.data.once("error", (error) => report(res, error));
            response.data.once("close", () => {
                if (!res.writableEnded) res.destroy();
            });
            response.data.pipe(res);
        } catch (error) {
            lifetime.dispose();
            if (!lifetime.wasClientAborted()) report(res, error);
        }
    }),
);
export default router;
