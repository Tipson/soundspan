import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import { prisma } from "../../utils/db";
import { sendRouteError } from "../../utils/routeErrorResponse";

const SAVED_ENTITY_TYPES = new Set(["album", "artist"]);
const SOURCE_PATTERN = /^[a-z0-9_-]{1,32}$/;
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 200;

interface SavedEntityIdentity {
    type: "album" | "artist";
    source: string;
    entityId: string;
}

interface SavedEntityPayload extends SavedEntityIdentity {
    title: string;
    subtitle: string | null;
    imageUrl: string | null;
}

function scalarString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function parseBoundedInt(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
): number {
    const parsed = Number.parseInt(scalarString(value), 10);
    return Number.isFinite(parsed)
        ? Math.min(max, Math.max(min, parsed))
        : fallback;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return Boolean(input && typeof input === "object" && !Array.isArray(input));
}

function parseIdentity(input: unknown): SavedEntityIdentity | null {
    if (!isRecord(input)) return null;
    const type = scalarString(input.type);
    const source = scalarString(input.source).toLowerCase();
    const entityId = scalarString(input.entityId);

    if (
        !SAVED_ENTITY_TYPES.has(type) ||
        !SOURCE_PATTERN.test(source) ||
        entityId.length < 1 ||
        entityId.length > 512 ||
        /[\u0000-\u001f\u007f]/.test(entityId)
    ) {
        return null;
    }

    return { type: type as SavedEntityIdentity["type"], source, entityId };
}

function parseOptionalText(value: unknown, maxLength: number): string | null {
    if (value === undefined || value === null || value === "") return null;
    const parsed = scalarString(value);
    return parsed.length > 0 && parsed.length <= maxLength ? parsed : null;
}

function isSafeImageReference(value: string | null): boolean {
    if (!value) return true;
    return (
        /^https?:\/\//i.test(value) ||
        /^native:/i.test(value) ||
        /^\/(?!\/)/.test(value) ||
        /^[a-zA-Z0-9._/-]+$/.test(value)
    );
}

function parsePayload(input: unknown): SavedEntityPayload | null {
    if (!isRecord(input)) return null;
    const identity = parseIdentity(input);
    const title = scalarString(input.title);
    if (!identity || title.length < 1 || title.length > 300) return null;

    const subtitle = parseOptionalText(input.subtitle, 300);
    const imageUrl = parseOptionalText(input.imageUrl, 2048);
    if (
        (input.subtitle !== undefined &&
            input.subtitle !== null &&
            input.subtitle !== "" &&
            !subtitle) ||
        (input.imageUrl !== undefined &&
            input.imageUrl !== null &&
            input.imageUrl !== "" &&
            !imageUrl) ||
        !isSafeImageReference(imageUrl)
    ) {
        return null;
    }

    return { ...identity, title, subtitle, imageUrl };
}

function requireUserId(req: Request, res: Response): string | null {
    const userId = req.user?.id;
    if (!userId) {
        sendRouteError(res, 401, "Authentication required");
        return null;
    }
    return userId;
}

/** Lists the signed-in user's explicitly saved albums or artists. */
/**
 * @openapi
 * /api/library/saved:
 *   get:
 *     summary: List albums and artists explicitly saved by the current user
 *     tags: [Library]
 *     security: [{ apiKeyAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [album, artist] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 200, default: 80 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, minimum: 0, maximum: 100000, default: 0 }
 *     responses:
 *       200: { description: Account-scoped saved music collection }
 *       400: { description: Invalid entity type }
 *       401: { description: Authentication required }
 */
export async function handleListSavedMusicEntities(
    req: Request,
    res: Response,
) {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const requestedType = scalarString(req.query.type);
    if (requestedType && !SAVED_ENTITY_TYPES.has(requestedType)) {
        return sendRouteError(res, 400, "type must be album or artist");
    }
    const limit = parseBoundedInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = parseBoundedInt(req.query.offset, 0, 0, 100_000);
    const where = {
        userId,
        ...(requestedType ? { entityType: requestedType } : {}),
    };
    const [items, total] = await Promise.all([
        prisma.savedMusicEntity.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip: offset,
            take: limit,
        }),
        prisma.savedMusicEntity.count({ where }),
    ]);
    res.json({ items, total });
}

/** Returns whether one provider identity is in the user's collection. */
/**
 * @openapi
 * /api/library/saved/status:
 *   get:
 *     summary: Get saved state for one exact album or artist identity
 *     tags: [Library]
 *     security: [{ apiKeyAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: type
 *         required: true
 *         schema: { type: string, enum: [album, artist] }
 *       - in: query
 *         name: source
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: entityId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Saved state and matching collection entry }
 *       400: { description: Invalid saved music identity }
 *       401: { description: Authentication required }
 */
export async function handleGetSavedMusicEntityStatus(
    req: Request,
    res: Response,
) {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const identity = parseIdentity(req.query as Record<string, unknown>);
    if (!identity) {
        return sendRouteError(res, 400, "Invalid saved music identity");
    }
    const item = await prisma.savedMusicEntity.findUnique({
        where: {
            userId_entityType_source_entityId: {
                userId,
                entityType: identity.type,
                source: identity.source,
                entityId: identity.entityId,
            },
        },
    });
    res.json({ saved: Boolean(item), item });
}

/** Adds or refreshes one personal collection entry without downloading files. */
/**
 * @openapi
 * /api/library/saved:
 *   put:
 *     summary: Save or refresh an album or artist in the personal Library
 *     tags: [Library]
 *     security: [{ apiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [type, source, entityId, title]
 *             properties:
 *               type: { type: string, enum: [album, artist] }
 *               source: { type: string }
 *               entityId: { type: string }
 *               title: { type: string }
 *               subtitle: { type: string, nullable: true }
 *               imageUrl: { type: string, nullable: true }
 *     responses:
 *       200: { description: Saved collection entry }
 *       400: { description: Invalid saved music entity }
 *       401: { description: Authentication required }
 *   delete:
 *     summary: Remove an album or artist from the personal Library
 *     tags: [Library]
 *     security: [{ apiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [type, source, entityId]
 *             properties:
 *               type: { type: string, enum: [album, artist] }
 *               source: { type: string }
 *               entityId: { type: string }
 *     responses:
 *       200: { description: Idempotent removal result }
 *       400: { description: Invalid saved music identity }
 *       401: { description: Authentication required }
 */
export async function handlePutSavedMusicEntity(req: Request, res: Response) {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const payload = parsePayload(req.body);
    if (!payload) {
        return sendRouteError(res, 400, "Invalid saved music entity");
    }
    const uniqueIdentity = {
        userId,
        entityType: payload.type,
        source: payload.source,
        entityId: payload.entityId,
    };
    const item = await prisma.savedMusicEntity.upsert({
        where: { userId_entityType_source_entityId: uniqueIdentity },
        create: {
            ...uniqueIdentity,
            title: payload.title,
            subtitle: payload.subtitle,
            imageUrl: payload.imageUrl,
        },
        update: {
            title: payload.title,
            subtitle: payload.subtitle,
            imageUrl: payload.imageUrl,
        },
    });
    res.json({ item, saved: true });
}

/** Idempotently removes one entry from the account's personal collection. */
export async function handleDeleteSavedMusicEntity(
    req: Request,
    res: Response,
) {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const identity = parseIdentity(req.body);
    if (!identity) {
        return sendRouteError(res, 400, "Invalid saved music identity");
    }
    const result = await prisma.savedMusicEntity.deleteMany({
        where: {
            userId,
            entityType: identity.type,
            source: identity.source,
            entityId: identity.entityId,
        },
    });
    res.json({ saved: false, removed: result.count > 0 });
}

export const savedMusicEntitiesRouter = Router();
savedMusicEntitiesRouter.get(
    "/saved/status",
    asyncHandler(handleGetSavedMusicEntityStatus),
);
savedMusicEntitiesRouter.get(
    "/saved",
    asyncHandler(handleListSavedMusicEntities),
);
savedMusicEntitiesRouter.put("/saved", asyncHandler(handlePutSavedMusicEntity));
savedMusicEntitiesRouter.delete(
    "/saved",
    asyncHandler(handleDeleteSavedMusicEntity),
);
