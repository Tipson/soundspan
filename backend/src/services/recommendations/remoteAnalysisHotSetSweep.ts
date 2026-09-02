import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { remoteAnalysisHotSetScheduler } from "./remoteAnalysisHotSet";

const log = logger.child("RemoteAnalysisHotSetSweep");
const ACTIVE_ACCOUNT_LOOKBACK_DAYS = 90;
const MAX_PLAY_ROWS = 1_000;
const MAX_ACTIVE_ACCOUNTS = 100;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000;

interface RemoteAnalysisHotSetSweepDependencies {
    loadActiveUserIds: () => Promise<string[]>;
    scheduleUser: (userId: string) => Promise<void>;
}

/** Bounded background admission of account hot sets, independent of page visits. */
export class RemoteAnalysisHotSetSweep {
    constructor(
        private readonly dependencies: RemoteAnalysisHotSetSweepDependencies,
    ) {}

    async runOnce(): Promise<number> {
        const userIds = await this.dependencies.loadActiveUserIds();
        let scheduled = 0;
        for (const userId of userIds.slice(0, MAX_ACTIVE_ACCOUNTS)) {
            try {
                await this.dependencies.scheduleUser(userId);
                scheduled += 1;
            } catch (error) {
                log.warn("Account hot-set sweep failed", { userId, error });
            }
        }
        return scheduled;
    }
}

async function loadActiveUserIds(): Promise<string[]> {
    const since = new Date(
        Date.now() - ACTIVE_ACCOUNT_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000,
    );
    const rows = await prisma.play.findMany({
        where: { playedAt: { gte: since } },
        orderBy: { playedAt: "desc" },
        take: MAX_PLAY_ROWS,
        select: { userId: true },
    });
    return Array.from(new Set(rows.map(({ userId }) => userId))).slice(
        0,
        MAX_ACTIVE_ACCOUNTS,
    );
}

const runtimeSweep = new RemoteAnalysisHotSetSweep({
    loadActiveUserIds,
    scheduleUser: (userId) =>
        remoteAnalysisHotSetScheduler.schedule({
            userId,
            sessionId: "background-hot-set",
            surface: "wave",
            candidates: [],
        }),
});

let sweepInterval: ReturnType<typeof setInterval> | null = null;
let sweepRunning = false;

async function runSupervisedSweep(): Promise<void> {
    if (sweepRunning) return;
    sweepRunning = true;
    try {
        const count = await runtimeSweep.runOnce();
        log.info("Account hot-set sweep completed", {
            scheduledAccounts: count,
        });
    } catch (error) {
        log.warn("Account hot-set sweep failed before scheduling", { error });
    } finally {
        sweepRunning = false;
    }
}

/** Start immediate and six-hourly online hot-set enrichment. */
export function startRemoteAnalysisHotSetSweep(): void {
    if (sweepInterval) return;
    void runSupervisedSweep();
    sweepInterval = setInterval(() => {
        void runSupervisedSweep();
    }, SWEEP_INTERVAL_MS);
    sweepInterval.unref?.();
}

/** Stop periodic online hot-set enrichment. */
export function stopRemoteAnalysisHotSetSweep(): void {
    if (!sweepInterval) return;
    clearInterval(sweepInterval);
    sweepInterval = null;
}
