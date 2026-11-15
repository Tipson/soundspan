import type { CookieOptions, Request } from "express";
import { createHash } from "node:crypto";
import { readCookie } from "../utils/cookies";

/** Dashboard sessions expire independently of ordinary access/refresh tokens. */
export const QUEUE_DASHBOARD_TTL_SECONDS = 15 * 60;
/** Audience accepted only by the queue dashboard authentication boundary. */
export const QUEUE_DASHBOARD_AUDIENCE = "soundspan-queue-dashboard";
/** A browser binding is not a credential and remains scoped to API requests. */
export const DASHBOARD_BINDING_TTL_SECONDS = 24 * 60 * 60;

/** Returns the non-authenticating binding cookie name under the HTTPS policy. */
export function dashboardBindingCookieName(secure: boolean): string {
    return secure
        ? "__Secure-soundspan-dashboard-binding"
        : "soundspan-dashboard-binding";
}

/** Returns identical set/clear attributes for the browser binding. */
export function dashboardBindingCookieOptions(secure: boolean): CookieOptions {
    return { httpOnly: true, sameSite: "strict", secure, path: "/api" };
}

/** Reads only a bounded opaque binding ID; it never authenticates a user. */
export function readDashboardBinding(
    req: Request | undefined,
    secure: boolean,
): string | null {
    if (!req?.headers) return null;
    const value = readCookie(req, dashboardBindingCookieName(secure));
    return value !== null && /^[a-f0-9]{48}$/.test(value) ? value : null;
}

/** Derives a scoped association key without storing a raw bearer credential. */
export function hashDashboardBearer(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/** Returns the dashboard-only cookie name under the configured HTTPS policy. */
export function queueDashboardCookieName(secure: boolean): string {
    return secure ? "__Secure-soundspan-queues" : "soundspan-queues";
}

/** Returns matching set/clear attributes without broadening cookie transport. */
export function queueDashboardCookieOptions(secure: boolean): CookieOptions {
    return {
        httpOnly: true,
        sameSite: "strict",
        secure,
        path: "/api/admin/queues",
    };
}
