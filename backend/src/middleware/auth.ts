import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { findApiKeyRecord, isApiKeyExpired } from "../utils/apiKeyHash";
import jwt from "jsonwebtoken";
import { sendRouteError } from "../utils/routeErrorResponse";
import {
    QUEUE_DASHBOARD_AUDIENCE,
    QUEUE_DASHBOARD_TTL_SECONDS,
    queueDashboardCookieName,
    readDashboardBinding,
} from "./queueDashboardCookie";
import { readCookie } from "../utils/cookies";
import {
    DashboardStateUnavailableError,
    type DashboardSessions,
} from "../utils/dashboardSessions";

// JWT_SECRET is required - SESSION_SECRET (a required, stable deploy secret;
// docker-entrypoint.sh fails fast when it is missing) is the fallback.
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET;

if (!JWT_SECRET) {
    throw new Error(
        "JWT_SECRET or SESSION_SECRET environment variable is required for authentication",
    );
}

// Type assertion after validation - JWT_SECRET is guaranteed to be a string
const JWT_SECRET_VALIDATED: string = JWT_SECRET;

class AuthBackendUnavailableError extends Error {
    constructor(cause: unknown) {
        super("Authentication backend unavailable", { cause });
        this.name = "AuthBackendUnavailableError";
    }
}

declare global {
    namespace Express {
        interface Request {
            user?: {
                id: string;
                username: string;
                role: string;
            };
        }
    }
}

export interface AuthenticatedRequest extends Request {
    user: {
        id: string;
        username: string;
        role: string;
    };
}

export interface JWTPayload {
    userId: string;
    username?: string;
    role?: string;
    tokenVersion?: number;
    type?: string;
    purpose?: string;
    aud?: string | string[];
    bindingId?: string;
    grantEpoch?: string;
    grantNonce?: string;
}

function isJwtPayloadShape(value: unknown): value is { userId: string } {
    return (
        typeof value === "object" &&
        value !== null &&
        "userId" in value &&
        typeof value.userId === "string"
    );
}

/** Creates a short-lived access token for authenticated API flows. */
export function generateToken(user: {
    id: string;
    username: string;
    role: string;
    tokenVersion: number;
}): string {
    return jwt.sign(
        {
            userId: user.id,
            username: user.username,
            role: user.role,
            tokenVersion: user.tokenVersion,
        },
        JWT_SECRET_VALIDATED,
        { expiresIn: "24h" },
    );
}

/** Creates a long-lived refresh token tied to the user's token version. */
export function generateRefreshToken(user: {
    id: string;
    tokenVersion: number;
}): string {
    return jwt.sign(
        {
            userId: user.id,
            tokenVersion: user.tokenVersion,
            type: "refresh",
        },
        JWT_SECRET_VALIDATED,
        { expiresIn: "30d" },
    );
}

/** Creates an audience-bound token used only by the short dashboard session. */
export function generateQueueDashboardToken(
    user: {
        id: string;
        tokenVersion: number;
    },
    grant: { bindingId: string; epoch: string; nonce: string },
): string {
    return jwt.sign(
        {
            userId: user.id,
            tokenVersion: user.tokenVersion,
            type: "queue-dashboard",
            bindingId: grant.bindingId,
            grantEpoch: grant.epoch,
            grantNonce: grant.nonce,
        },
        JWT_SECRET_VALIDATED,
        {
            algorithm: "HS256",
            audience: QUEUE_DASHBOARD_AUDIENCE,
            expiresIn: QUEUE_DASHBOARD_TTL_SECONDS,
        },
    );
}

/**
 * Verify an HS256 access/refresh token against the validated JWT secret and
 * require an object payload with a string `userId`. The `algorithms` pin
 * prevents a token from being accepted under a different (weaker or `none`)
 * algorithm, and centralizes secret resolution so callers never re-read
 * `process.env` inline. Throws on an invalid, expired, wrong-algorithm, or
 * malformed token.
 */
export function verifyAuthToken(token: string): JWTPayload {
    const payload = jwt.verify(token, JWT_SECRET_VALIDATED, {
        algorithms: ["HS256"],
    });
    if (!isJwtPayloadShape(payload)) {
        throw new Error("Malformed token payload");
    }
    // Runtime validation above establishes the required JWTPayload invariant.
    return payload as JWTPayload;
}

/**
 * Verify a credential presented for direct API/socket access as a short-lived
 * access token. Delegates to `verifyAuthToken` (HS256-pinned, single validated
 * secret) and rejects all non-access token types, including refresh tokens.
 * Only tokens minted without `type` and `purpose` claims are accepted. Throws on an invalid,
 * expired, wrong-algorithm, malformed, or non-access token.
 */
export function verifyAccessToken(token: string): JWTPayload {
    const payload = verifyAuthToken(token);
    if (payload.type !== undefined || payload.purpose !== undefined) {
        throw new Error("Token is not an access token");
    }
    return payload;
}

/**
 * Resolve an access token to its user, enforcing token type (via
 * `verifyAccessToken`) and `tokenVersion` freshness. Returns `null` when the
 * user no longer exists or the token predates a password change. Throws a JWT
 * verification error for invalid credentials and a typed availability error
 * when the user lookup fails.
 */
async function resolveAccessTokenUser(
    token: string,
): Promise<{ id: string; username: string; role: string } | null> {
    const decoded = verifyAccessToken(token);
    let user;
    try {
        user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: {
                id: true,
                username: true,
                role: true,
                tokenVersion: true,
            },
        });
    } catch (cause) {
        throw new AuthBackendUnavailableError(cause);
    }
    if (!user) {
        return null;
    }
    // Validate tokenVersion - reject if password was changed
    if (
        decoded.tokenVersion === undefined ||
        decoded.tokenVersion !== user.tokenVersion
    ) {
        return null;
    }
    return { id: user.id, username: user.username, role: user.role };
}

/**
 * Helper function to authenticate a request using an API key or JWT
 * @param req Express request object
 * @param checkQueryToken Whether to check for token in query params (for streaming)
 * @returns User object if authenticated, null otherwise
 * @throws AuthBackendUnavailableError when credential persistence cannot be read
 */
async function authenticateRequest(
    req: Request,
    checkQueryToken: boolean = false,
): Promise<{ id: string; username: string; role: string } | null> {
    // Check for API key in X-API-Key header
    const apiKey = req.headers["x-api-key"] as string;
    if (apiKey) {
        try {
            const apiKeyRecord = await findApiKeyRecord(apiKey, (key) =>
                prisma.apiKey.findUnique({
                    where: { key },
                    include: {
                        user: {
                            select: { id: true, username: true, role: true },
                        },
                    },
                }),
            );

            if (
                apiKeyRecord &&
                apiKeyRecord.user &&
                !isApiKeyExpired(apiKeyRecord.createdAt)
            ) {
                // Update last used timestamp (async, don't block)
                prisma.apiKey
                    .update({
                        where: { id: apiKeyRecord.id },
                        data: { lastUsed: new Date() },
                    })
                    .catch((err) => {
                        logger.debug("Failed to update API key lastUsed", err);
                    });

                return apiKeyRecord.user;
            }
        } catch (cause) {
            throw new AuthBackendUnavailableError(cause);
        }
    }

    // Check for token in query param (for streaming URLs)
    if (checkQueryToken) {
        const tokenParam = req.query.token as string;
        if (tokenParam) {
            try {
                const user = await resolveAccessTokenUser(tokenParam);
                if (user) return user;
            } catch (cause) {
                if (cause instanceof AuthBackendUnavailableError) {
                    throw cause;
                }
                logger.debug("Query token validation failed", cause);
            }
        }
    }

    // Check JWT token in Authorization header
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
        ? authHeader.substring(7)
        : null;

    if (token) {
        try {
            const user = await resolveAccessTokenUser(token);
            if (user) return user;
        } catch (cause) {
            if (cause instanceof AuthBackendUnavailableError) {
                throw cause;
            }
            logger.debug("Bearer token validation failed", cause);
        }
    }

    return null;
}

/** Enforces authenticated access and attaches the resolved user to `req.user`. */
export async function requireAuth(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    let user;
    try {
        user = await authenticateRequest(req, false);
    } catch (cause) {
        if (cause instanceof AuthBackendUnavailableError) {
            logger.warn("Authentication backend unavailable", cause);
            return sendRouteError(
                res,
                503,
                "Authentication service unavailable",
                { code: "AUTH_BACKEND_UNAVAILABLE" },
            );
        }
        throw cause;
    }
    if (user) {
        req.user = user;
        return next();
    }
    return res
        .status(401)
        .json({ error: "Not authenticated", code: "AUTH_REQUIRED" });
}

/** Rejects API-key transport for operations that require an interactive user. */
export function requireInteractiveSession(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    // Interactive password/current-factor step-up is a documented frontend follow-up outside this slice.
    if (req.headers["x-api-key"] !== undefined) {
        return sendRouteError(
            res,
            403,
            "Interactive session authentication required",
        );
    }
    return next();
}

/** Enforces administrator role access after `requireAuth` has populated `req.user`. */
export async function requireAdmin(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    if (!req.user || req.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
    }
    next();
}

/**
 * Creates the dedicated Bull Board guard. Cookie credentials cannot authorize
 * any other API; current administrator rights and token revocation are checked
 * on every request. Cookie-backed mutations require same-origin Fetch Metadata.
 * The HTTPS cookie policy is supplied by composition, not forwarded headers.
 */
export function createQueueDashboardAccess(
    secureCookies: boolean,
    sessions: Pick<DashboardSessions, "grantActive">,
) {
    const dashboardLog = logger.child("QueueDashboard");
    return async (req: Request, res: Response, next: NextFunction) => {
        if (req.headers["x-api-key"] !== undefined) {
            return sendRouteError(
                res,
                403,
                "Interactive session authentication required",
            );
        }
        try {
            const header = req.headers.authorization;
            let payload: JWTPayload;
            if (header !== undefined) {
                if (!header.startsWith("Bearer "))
                    return sendRouteError(res, 401, "Not authenticated");
                payload = verifyAccessToken(header.slice(7));
            } else {
                const token = readCookie(
                    req,
                    queueDashboardCookieName(secureCookies),
                );
                if (!token)
                    return sendRouteError(res, 401, "Not authenticated");
                payload = verifyAuthToken(token);
                if (
                    payload.type !== "queue-dashboard" ||
                    payload.purpose !== undefined ||
                    payload.aud !== QUEUE_DASHBOARD_AUDIENCE
                ) {
                    return sendRouteError(res, 401, "Not authenticated");
                }
                const bindingId = readDashboardBinding(req, secureCookies);
                if (
                    !bindingId ||
                    payload.bindingId !== bindingId ||
                    typeof payload.grantEpoch !== "string" ||
                    !/^[a-f0-9]{48}$/.test(payload.grantEpoch) ||
                    typeof payload.grantNonce !== "string" ||
                    !/^[a-f0-9]{48}$/.test(payload.grantNonce) ||
                    typeof payload.tokenVersion !== "number"
                ) {
                    return sendRouteError(res, 401, "Not authenticated");
                }
                if (
                    !(await sessions.grantActive(
                        bindingId,
                        {
                            ownerId: payload.userId,
                            tokenVersion: payload.tokenVersion,
                            epoch: payload.grantEpoch,
                        },
                        payload.grantNonce,
                    ))
                ) {
                    return sendRouteError(res, 401, "Not authenticated");
                }
                if (
                    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
                    req.headers["sec-fetch-site"] !== "same-origin"
                ) {
                    return sendRouteError(
                        res,
                        403,
                        "Same-origin dashboard request required",
                    );
                }
            }
            let user;
            try {
                user = await prisma.user.findUnique({
                    where: { id: payload.userId },
                    select: {
                        id: true,
                        username: true,
                        role: true,
                        tokenVersion: true,
                        pendingDeletionAt: true,
                    },
                });
            } catch (cause) {
                throw new AuthBackendUnavailableError(cause);
            }
            if (
                !user ||
                user.pendingDeletionAt ||
                payload.tokenVersion !== user.tokenVersion
            )
                return sendRouteError(res, 401, "Not authenticated");
            if (user.role !== "admin")
                return sendRouteError(res, 403, "Admin access required");
            req.user = {
                id: user.id,
                username: user.username,
                role: user.role,
            };
            res.setHeader("Cache-Control", "no-store");
            return next();
        } catch (cause) {
            if (
                cause instanceof AuthBackendUnavailableError ||
                cause instanceof DashboardStateUnavailableError
            ) {
                dashboardLog.warn("Authentication backend unavailable", cause);
                return sendRouteError(
                    res,
                    503,
                    "Authentication service unavailable",
                );
            }
            return sendRouteError(res, 401, "Not authenticated");
        }
    };
}

// For streaming URLs that may use query params or need special handling
/** Authenticates via API key, query token, or bearer token for media routes. */
export async function requireAuthOrToken(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    let user;
    try {
        user = await authenticateRequest(req, true);
    } catch (cause) {
        if (cause instanceof AuthBackendUnavailableError) {
            logger.warn("Authentication backend unavailable", cause);
            return sendRouteError(
                res,
                503,
                "Authentication service unavailable",
                { code: "AUTH_BACKEND_UNAVAILABLE" },
            );
        }
        throw cause;
    }
    if (user) {
        req.user = user;
        return next();
    }

    return res
        .status(401)
        .json({ error: "Not authenticated", code: "AUTH_REQUIRED" });
}
