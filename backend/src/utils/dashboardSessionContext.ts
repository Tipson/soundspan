import type { Request } from "express";
import { verifyAccessToken } from "../middleware/auth";
import {
    hashDashboardBearer,
    readDashboardBinding,
} from "../middleware/queueDashboardCookie";

/** Identifies dashboard-only state without storing credentials or changing API auth. */
export function getDashboardRevocationContext(
    req: Request | undefined,
    secure: boolean,
): { bindingId: string | null; credentialHash: string | null } {
    let credentialHash: string | null = null;
    const header = req?.headers?.authorization;
    if (header?.startsWith("Bearer ")) {
        try {
            const token = header.slice(7);
            if (verifyAccessToken(token).role === "admin")
                credentialHash = hashDashboardBearer(token);
        } catch {
            credentialHash = null;
        }
    }
    return { bindingId: readDashboardBinding(req, secure), credentialHash };
}
