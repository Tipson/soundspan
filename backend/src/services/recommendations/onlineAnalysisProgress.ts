import type { Prisma } from "@prisma/client";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { ExpiringMemo } from "../../workers/enrichmentIdlePolicy";

const memo = new ExpiringMemo<
    Awaited<ReturnType<typeof loadOnlineAnalysisProgress>>
>(30_000);

/** Read the reservation counter, which includes denied attempts, not completions. */
async function readBudgetChecks(now: Date): Promise<number | null> {
    if (!redisClient.isReady) return null;
    try {
        const value = await redisClient
            .withCommandOptions({ abortSignal: AbortSignal.timeout(1_000) })
            .get(
                `recommendation:remote-analysis:budget:${now.toISOString().slice(0, 10)}`,
            );
        if (value === null) return 0;
        const count = Number(value);
        return /^\d+$/.test(value) && Number.isSafeInteger(count)
            ? count
            : null;
    } catch {
        // Optional quota telemetry must not hide durable analysis coverage.
        return null;
    }
}

/** Aggregate shared recordings once, independently of local library enrichment. */
export async function loadOnlineAnalysisProgress(now = new Date()) {
    const since = new Date(now.getTime() - 86_400_000);
    const [counts, checkedToday] = await Promise.all([
        prisma.$transaction(
            async (db) => {
                const activeSpace = await db.embeddingSpace.findFirst({
                    where: { status: "active", cleaningAt: null },
                    select: { id: true, family: true },
                    orderBy: { createdAt: "desc" },
                });
                const total = await db.canonicalRecording.count();
                const audioCompleted = await db.canonicalRecording.count({
                    where: { analysisStatus: "completed" },
                });
                const audioFailed = await db.canonicalRecording.count({
                    where: { analysisStatus: "failed" },
                });
                const audioLast24h = await db.canonicalRecording.count({
                    where: {
                        analysisStatus: "completed",
                        analyzedAt: { gte: since },
                    },
                });
                let embeddings = null;
                if (activeSpace) {
                    const vector = { spaceId: activeSpace.id };
                    const where: Prisma.CanonicalRecordingWhereInput = {
                        embeddings: { some: vector },
                    };
                    const completed = await db.canonicalRecording.count({
                        where,
                    });
                    const failed = await db.canonicalRecording.count({
                        where: {
                            embeddingStatus: "failed",
                            embeddings: { none: vector },
                        },
                    });
                    const completedLast24h = await db.canonicalRecording.count({
                        where: {
                            embeddings: {
                                some: { ...vector, analyzedAt: { gte: since } },
                            },
                        },
                    });
                    embeddings = {
                        completed,
                        remaining: total - completed,
                        failed,
                        completedLast24h,
                    };
                }
                const activeAssets = await db.canonicalRecording.count({
                    where: {
                        analysisLeases: {
                            some: {
                                status: {
                                    in: [
                                        "downloading",
                                        "downloaded",
                                        "queued_essentia",
                                        "processing",
                                    ],
                                },
                                expiresAt: { gt: now },
                            },
                        },
                    },
                });
                return {
                    total,
                    activeSpace,
                    activeAssets,
                    audio: {
                        completed: audioCompleted,
                        remaining: total - audioCompleted,
                        failed: audioFailed,
                        completedLast24h: audioLast24h,
                    },
                    embeddings,
                };
            },
            {
                isolationLevel: "RepeatableRead",
                timeout: 5_000,
                maxWait: 2_000,
            },
        ),
        readBudgetChecks(now),
    ]);
    const resetsAt = new Date(now);
    resetsAt.setUTCHours(24, 0, 0, 0);
    return {
        generatedAt: now.toISOString(),
        enabled:
            config.features.audioAnalysis &&
            config.recommendations.remoteAnalysisEnabled,
        ...counts,
        budget: {
            dailyLimit: config.recommendations.remoteAnalysisDailyBudget,
            concurrency: config.recommendations.remoteAnalysisConcurrency,
            checkedToday,
            resetsAt: resetsAt.toISOString(),
        },
    };
}

/** Coalesce dashboard polls; this read-only endpoint never schedules analysis. */
export function getOnlineAnalysisProgress() {
    return memo.get(loadOnlineAnalysisProgress);
}
