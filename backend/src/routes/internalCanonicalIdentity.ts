import { Router } from "express";

import { config } from "../config";
import { enqueueCanonicalIdentityPromotion } from "../services/recommendations/canonicalIdentityPromotion";
import { logger } from "../utils/logger";
import { timingSafeCompare } from "../utils/timingSafe";

const router = Router();
const log = logger.child("InternalCanonicalIdentityRoute");
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_FINGERPRINT_LENGTH = 256_000;
const MUSICBRAINZ_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isBoundedString(value: unknown, maxLength: number): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= maxLength
    );
}

function isAuthorized(provided: string | undefined): boolean {
    const expected = config.internalApiSecret;
    return (
        typeof provided === "string" &&
        typeof expected === "string" &&
        expected.length > 0 &&
        timingSafeCompare(provided, expected)
    );
}

router.post("/promotions", async (req, res) => {
    if (!isAuthorized(req.get("x-internal-secret"))) {
        return res.status(403).json({ error: "Forbidden" });
    }

    const body =
        typeof req.body === "object" && req.body !== null ? req.body : {};
    const {
        sourceCanonicalId,
        expectedFingerprint,
        recordingMbid,
        confidence,
    } = body as Record<string, unknown>;
    if (
        !isBoundedString(sourceCanonicalId, MAX_IDENTIFIER_LENGTH) ||
        !isBoundedString(expectedFingerprint, MAX_FINGERPRINT_LENGTH) ||
        !isBoundedString(recordingMbid, MAX_IDENTIFIER_LENGTH) ||
        !MUSICBRAINZ_ID_PATTERN.test(recordingMbid) ||
        typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1
    ) {
        return res.status(400).json({ error: "Invalid promotion intent" });
    }

    try {
        const status = await enqueueCanonicalIdentityPromotion({
            sourceCanonicalId,
            expectedFingerprint,
            recordingMbid,
            confidence,
        });
        return res.status(status === "accepted" ? 202 : 409).json({ status });
    } catch (error) {
        log.warn("Failed to enqueue canonical identity promotion", { error });
        return res.status(503).json({ error: "Promotion handoff unavailable" });
    }
});

export default router;
