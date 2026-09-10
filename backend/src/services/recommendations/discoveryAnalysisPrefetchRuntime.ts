import { randomUUID } from "node:crypto";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import { canonicalIdentityResolver } from "./canonicalIdentity";
import { DiscoveryAnalysisPrefetch } from "./discoveryAnalysisPrefetch";
import {
    loadRemoteAnalysisCoveredCanonicalIds,
    RemoteAnalysisHotSetScheduler,
} from "./remoteAnalysisHotSet";
import { unifiedRecommendationService } from "./recommendationRuntime";
import { remoteAnalysisQueue } from "../../workers/queues";

const log = logger.child("DiscoveryAnalysisPrefetch");
const PREFIX = "recommendation:discovery-prefetch";
const INTERVAL_MS = 15 * 60_000;
const RUN_DEADLINE_MS = 150_000;
const LOCK_TTL_MS = 180_000;
const CURSOR_TTL_SECONDS = 7 * 24 * 3600;
const RELEASE_LOCK =
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';
let interval: ReturnType<typeof setInterval> | null = null;
let running: Promise<void> | null = null;
let controller: AbortController | null = null;

/** Diagnostic computation never creates recommendation exposures or playback history. */
export async function loadDiscoveryPrefetchCandidates(userId: string) {
    const stored = Number(await redisClient.get(`${PREFIX}:cursor:${userId}`));
    const cursor =
        Number.isSafeInteger(stored) && stored >= 0 && stored <= 1_000_000
            ? stored
            : 0;
    const feed = await unifiedRecommendationService.getPersonalizedFeed({
        userId,
        sessionId: "background-discovery-prefetch",
        surface: "wave",
        direction: "new",
        mood: null,
        limit: 12,
        cursor,
        excludeVideoIds: [],
        diagnostic: true,
    });
    return {
        candidates: feed.shelves.discovery.map((track) => ({
            ...track,
            canonicalKey: "",
            candidateSources: ["discovery-prefetch"],
            providerPrior: 1,
            lane: "discovery" as const,
        })),
        nextCursor: feed.nextCursor,
    };
}

async function run(signal: AbortSignal): Promise<void> {
    const token = randomUUID();
    const lockKey = `${PREFIX}:lock`;
    if (!(await redisClient.set(lockKey, token, { NX: true, PX: LOCK_TTL_MS })))
        return;
    const startedAt = Date.now();
    const isCurrent = async () => {
        if (signal.aborted) return false;
        const currentToken = await redisClient.get(lockKey);
        return (
            !signal.aborted &&
            Date.now() - startedAt < RUN_DEADLINE_MS &&
            currentToken === token
        );
    };
    const canContinue = async () => {
        if (!(await isCurrent())) return false;
        const [counts, rawUsed] = await Promise.all([
            remoteAnalysisQueue.getJobCounts(),
            redisClient.get(
                `recommendation:remote-analysis:budget:${new Date().toISOString().slice(0, 10)}`,
            ),
        ]);
        const used = Number(rawUsed ?? 0);
        const pending = counts.waiting + counts.active + counts.delayed;
        // Stop before estimated commitments enter the half reserved for foreground work.
        // The worker's atomic global budget remains the final admission authority.
        return (
            Number.isFinite(used) &&
            pending < 12 &&
            used + pending + 12 <=
                Math.floor(config.recommendations.remoteAnalysisDailyBudget / 2)
        );
    };
    const scheduler = new RemoteAnalysisHotSetScheduler({
        enabled: true,
        isAccountEligible: async (userId) =>
            (
                await prisma.user.findUnique({
                    where: { id: userId },
                    select: { isTestAccount: true },
                })
            )?.isTestAccount === false,
        loadCoveredCanonicalIds: loadRemoteAnalysisCoveredCanonicalIds,
        resolveCanonicalIdentities: (candidates) =>
            Promise.all(
                candidates.map(async (candidate) => {
                    const canonical =
                        await canonicalIdentityResolver.resolve(candidate);
                    return {
                        ...candidate,
                        canonicalKey: canonical.canonicalKey,
                        canonicalRecordingId: canonical.id,
                    };
                }),
            ),
        enqueue: async (job, jobId) => {
            if (!(await isCurrent())) return;
            if (await remoteAnalysisQueue.getJob(jobId)) return;
            if (!(await isCurrent())) return;
            await remoteAnalysisQueue.add("analyze", job, {
                jobId,
                priority: 10,
            });
        },
    });
    try {
        const prefetch = new DiscoveryAnalysisPrefetch({
            loadUsers: async () => {
                const rows = await prisma.play.groupBy({
                    by: ["userId"],
                    where: {
                        playedAt: {
                            gte: new Date(Date.now() - 90 * 86_400_000),
                        },
                        user: { isTestAccount: false },
                    },
                    orderBy: { userId: "asc" },
                    take: 100,
                });
                const last = await redisClient.get(`${PREFIX}:last-user`);
                const users = rows.map((row) => row.userId);
                const index = last ? users.findIndex((id) => id > last) : 0;
                return index > 0
                    ? [...users.slice(index), ...users.slice(0, index)]
                    : users;
            },
            canContinue,
            loadCandidates: loadDiscoveryPrefetchCandidates,
            admit: (userId, candidates) =>
                scheduler.schedule({
                    userId,
                    sessionId: "background-discovery-prefetch",
                    surface: "wave",
                    candidates,
                }),
            advance: async (userId, cursor) => {
                if (!(await isCurrent())) return;
                await redisClient.set(
                    `${PREFIX}:cursor:${userId}`,
                    String(cursor),
                    { EX: CURSOR_TTL_SECONDS },
                );
                await redisClient.set(`${PREFIX}:last-user`, userId, {
                    EX: CURSOR_TTL_SECONDS,
                });
            },
            failed: (userId, error) =>
                log.warn("Discovery preparation failed for account", {
                    userId,
                    error,
                }),
        });
        const accounts = await prefetch.run(signal);
        log.info("Discovery preparation completed", {
            accounts,
            elapsedMs: Date.now() - startedAt,
            cancelled: signal.aborted,
        });
    } finally {
        await redisClient.eval(RELEASE_LOCK, {
            keys: [lockKey],
            arguments: [token],
        });
    }
}

function tick(): void {
    if (running) return;
    controller = new AbortController();
    running = run(controller.signal)
        .catch((error) => log.warn("Discovery preparation failed", { error }))
        .finally(() => {
            running = null;
        });
}

/** Start one low-priority pass every fifteen minutes; duplicate workers share a Redis lease. */
export function startDiscoveryAnalysisPrefetch(): void {
    if (
        interval ||
        !config.features.audioAnalysis ||
        !config.recommendations.remoteAnalysisEnabled
    )
        return;
    tick();
    interval = setInterval(tick, INTERVAL_MS);
    interval.unref?.();
}

/** Fence late results before closing Bull; draining has an explicit shutdown deadline. */
export async function stopDiscoveryAnalysisPrefetch(): Promise<void> {
    if (interval) clearInterval(interval);
    interval = null;
    controller?.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            running,
            new Promise<void>((resolve) => {
                timeout = setTimeout(resolve, 20_000);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}
