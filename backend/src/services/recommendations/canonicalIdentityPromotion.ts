import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import { runCanonicalIdentityTransaction } from "./canonicalIdentity";
import { persistCanonicalDurableIdentityInTransaction } from "./durableIdentityPersistence";
import type { RecommendationCandidate } from "./types";
import { prisma } from "../../utils/db";

const DEFERRED_RETRY_MS = 30_000;
const FAILED_RETRY_MAX_MS = 5 * 60_000;
const MAX_SETTLEMENT_FAILURES = 8;
const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 50;

export interface CanonicalIdentityPromotionInput {
    sourceCanonicalId: string;
    expectedFingerprint: string;
    recordingMbid: string;
    confidence: number;
}

export type CanonicalIdentityPromotionAdmission = "accepted" | "stale";
export type CanonicalIdentityPromotionOutcome =
    | "completed"
    | "deferred"
    | "failed"
    | "stale";

type CanonicalIdentityPromotionIntent =
    Prisma.CanonicalIdentityPromotionIntentGetPayload<object>;

function intentKey(input: CanonicalIdentityPromotionInput) {
    return {
        sourceCanonicalId: input.sourceCanonicalId,
        fingerprintHash: createHash("sha256")
            .update(input.expectedFingerprint)
            .digest("hex"),
        recordingMbid: input.recordingMbid,
    };
}

/**
 * Fence a completed AcoustID lookup and durably hand it to the sole merge
 * owner. The source state and intent insert commit together.
 */
export async function enqueueCanonicalIdentityPromotion(
    input: CanonicalIdentityPromotionInput,
): Promise<CanonicalIdentityPromotionAdmission> {
    return runCanonicalIdentityTransaction(async (transaction) => {
        const existing =
            await transaction.canonicalIdentityPromotionIntent.findUnique({
                where: {
                    sourceCanonicalId_fingerprintHash_recordingMbid:
                        intentKey(input),
                },
                select: { id: true, status: true },
            });
        if (existing) {
            if (existing.status === "superseded") return "stale";
            if (existing.status !== "failed") return "accepted";

            const refenced = await transaction.canonicalRecording.updateMany({
                where: {
                    id: input.sourceCanonicalId,
                    fingerprint: input.expectedFingerprint,
                    identityLookupStatus: "processing",
                    recordingMbid: null,
                    mergedIntoId: null,
                },
                data: {
                    identityLookupStatus: "merge_pending",
                    identityLookupError: null,
                    identityLookupUpdatedAt: new Date(),
                },
            });
            if (refenced.count !== 1) return "stale";
            await transaction.canonicalIdentityPromotionIntent.update({
                where: { id: existing.id },
                data: {
                    expectedFingerprint: input.expectedFingerprint,
                    confidence: input.confidence,
                    status: "pending",
                    failureCount: 0,
                    availableAt: new Date(),
                    claimedAt: null,
                    completedAt: null,
                    lastError: null,
                },
            });
            return "accepted";
        }

        const fenced = await transaction.canonicalRecording.updateMany({
            where: {
                id: input.sourceCanonicalId,
                fingerprint: input.expectedFingerprint,
                identityLookupStatus: "processing",
                recordingMbid: null,
                mergedIntoId: null,
            },
            data: {
                identityLookupStatus: "merge_pending",
                identityLookupError: null,
                identityLookupUpdatedAt: new Date(),
            },
        });
        if (fenced.count !== 1) return "stale";

        await transaction.canonicalIdentityPromotionIntent.create({
            data: {
                ...intentKey(input),
                expectedFingerprint: input.expectedFingerprint,
                confidence: input.confidence,
            },
        });
        return "accepted";
    });
}

function sourceToCandidate(source: {
    id: string;
    canonicalKey: string;
    fingerprint: string | null;
    title: string;
    artist: string;
    duration: number;
}): RecommendationCandidate {
    return {
        id: source.id,
        canonicalKey: source.canonicalKey,
        canonicalRecordingId: source.id,
        title: source.title,
        duration: source.duration,
        artist: { id: null, name: source.artist },
        album: { id: null, title: "", coverArt: null },
        source: "library",
        streamSource: "library",
        provider: { tidalTrackId: null, youtubeVideoId: null },
        fingerprint: source.fingerprint,
        candidateSources: ["acoustid-promotion"],
        providerPrior: 1,
    };
}

async function settleSelectedPromotion(
    transaction: Prisma.TransactionClient,
    intent: CanonicalIdentityPromotionIntent,
): Promise<CanonicalIdentityPromotionOutcome | null> {
    const now = new Date();
    const claimed =
        await transaction.canonicalIdentityPromotionIntent.updateMany({
            where: {
                id: intent.id,
                status: "pending",
                attemptCount: intent.attemptCount,
                availableAt: { lte: now },
            },
            data: {
                status: "processing",
                claimedAt: now,
                attemptCount: { increment: 1 },
                lastError: null,
            },
        });
    if (claimed.count !== 1) return null;

    const source = await transaction.canonicalRecording.findUnique({
        where: { id: intent.sourceCanonicalId },
        select: {
            id: true,
            canonicalKey: true,
            fingerprint: true,
            title: true,
            artist: true,
            duration: true,
        },
    });
    if (!source) {
        // The FK is ON DELETE CASCADE, so this can only be observed inside a
        // concurrent serializable snapshot. Retrying lets that delete settle.
        throw new Error("Canonical identity promotion source is missing");
    }

    const result = await persistCanonicalDurableIdentityInTransaction(
        transaction,
        sourceToCandidate(source),
        {
            tidalTrackId: null,
            isrc: null,
            recordingMbid: intent.recordingMbid,
            confidence: intent.confidence,
            source: "acoustid",
        },
        {
            expectedFingerprint: intent.expectedFingerprint,
            expectedLookupStatus: "merge_pending",
        },
    );

    if (result.status === "deferred") {
        await transaction.canonicalIdentityPromotionIntent.update({
            where: { id: intent.id },
            data: {
                status: "pending",
                availableAt: new Date(now.getTime() + DEFERRED_RETRY_MS),
                claimedAt: null,
                failureCount: 0,
                lastError: "active-analysis",
            },
        });
        return "deferred";
    }

    await transaction.canonicalIdentityPromotionIntent.update({
        where: { id: intent.id },
        data: {
            status: result.status === "stale" ? "superseded" : "completed",
            completedAt: now,
            claimedAt: null,
            failureCount: 0,
            expectedFingerprint: "",
            lastError: null,
        },
    });
    return result.status;
}

function failedRetryDelayMs(attemptCount: number): number {
    const exponent = Math.min(4, Math.max(0, attemptCount));
    return Math.min(FAILED_RETRY_MAX_MS, DEFERRED_RETRY_MS * 2 ** exponent);
}

function safeErrorName(error: unknown): string {
    if (!(error instanceof Error)) return "UnknownError";
    return error.name.slice(0, 64) || "Error";
}

async function recoverFailedPromotion(
    intent: CanonicalIdentityPromotionIntent,
    error: unknown,
): Promise<"deferred" | "failed" | null> {
    const lastError = safeErrorName(error);
    if (intent.failureCount + 1 < MAX_SETTLEMENT_FAILURES) {
        const recovered =
            await prisma.canonicalIdentityPromotionIntent.updateMany({
                where: {
                    id: intent.id,
                    status: "pending",
                    attemptCount: intent.attemptCount,
                    failureCount: intent.failureCount,
                },
                data: {
                    attemptCount: { increment: 1 },
                    failureCount: { increment: 1 },
                    availableAt: new Date(
                        Date.now() + failedRetryDelayMs(intent.failureCount),
                    ),
                    claimedAt: null,
                    lastError,
                },
            });
        return recovered.count === 1 ? "deferred" : null;
    }

    return runCanonicalIdentityTransaction(async (transaction) => {
        const failed =
            await transaction.canonicalIdentityPromotionIntent.updateMany({
                where: {
                    id: intent.id,
                    status: "pending",
                    attemptCount: intent.attemptCount,
                    failureCount: intent.failureCount,
                },
                data: {
                    status: "failed",
                    attemptCount: { increment: 1 },
                    failureCount: { increment: 1 },
                    completedAt: new Date(),
                    claimedAt: null,
                    expectedFingerprint: "",
                    lastError,
                },
            });
        if (failed.count !== 1) return null;
        await transaction.canonicalRecording.updateMany({
            where: {
                id: intent.sourceCanonicalId,
                fingerprint: intent.expectedFingerprint,
                identityLookupStatus: "merge_pending",
                recordingMbid: null,
                mergedIntoId: null,
            },
            data: {
                identityLookupStatus: "failed",
                identityLookupError: "canonical-promotion-failed",
                identityLookupUpdatedAt: new Date(),
            },
        });
        return "failed";
    });
}

/** Atomically claim and settle one durable promotion intent. */
export async function processNextCanonicalIdentityPromotion(): Promise<CanonicalIdentityPromotionOutcome | null> {
    const intent = await prisma.canonicalIdentityPromotionIntent.findFirst({
        where: { status: "pending", availableAt: { lte: new Date() } },
        orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    });
    if (!intent) return null;

    try {
        return await runCanonicalIdentityTransaction((transaction) =>
            settleSelectedPromotion(transaction, intent),
        );
    } catch (error) {
        // The failed settlement transaction rolled its claim back. Move only
        // that unchanged pending version into bounded backoff, so a poison
        // intent cannot remain at the ready head or overwrite another
        // consumer's completed/deferred settlement.
        return recoverFailedPromotion(intent, error);
    }
}

/** Drain only a bounded number of intents so one sweep cannot monopolize a worker. */
export async function processCanonicalIdentityPromotionBatch(
    batchSize = DEFAULT_BATCH_SIZE,
): Promise<Record<CanonicalIdentityPromotionOutcome, number>> {
    const counts: Record<CanonicalIdentityPromotionOutcome, number> = {
        completed: 0,
        deferred: 0,
        failed: 0,
        stale: 0,
    };
    const limit = Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(batchSize)));
    for (let index = 0; index < limit; index += 1) {
        const outcome = await processNextCanonicalIdentityPromotion();
        if (!outcome) break;
        counts[outcome] += 1;
    }
    return counts;
}
