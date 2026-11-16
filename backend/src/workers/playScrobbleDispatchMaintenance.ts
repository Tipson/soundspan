import { Prisma, type PrismaClient } from "@prisma/client";

/** Independent worker lifecycle; a Redis outage cannot suppress database maintenance. */
export function createPlayScrobbleMaintenanceLoop(
    tick: () => Promise<unknown>,
    failed: () => void,
) {
    let timer: ReturnType<typeof setInterval> | undefined;
    let active: Promise<void> | undefined;
    let stopped = true;
    const run = () => {
        if (stopped || active) return;
        active = Promise.resolve()
            .then(tick)
            .then(() => {}, failed)
            .finally(() => {
                active = undefined;
            });
    };
    return {
        start() {
            if (!stopped) return;
            stopped = false;
            timer = setInterval(run, 60_000);
            timer.unref();
            run();
        },
        async stop() {
            stopped = true;
            if (timer) clearInterval(timer);
            timer = undefined;
            await active;
        },
    };
}

/** Finite, anonymous measurements from one bounded maintenance pass. */
export interface PlayScrobbleMaintenanceSummary {
    recovered: number;
    expired: number;
    enqueued: number;
    enqueueFailures: number;
    receipts: number;
    purged: number;
    oldestDueSeconds: number;
    durationMs: number;
}

/** Uses the global expiry index and a rotating discovery cursor, with one total receipt budget. */
export function createPlayScrobbleMaintenance(
    database: PrismaClient,
    dependencies: {
        enqueue(wake: {
            version: 1;
            dispatchId: string;
            userId: string;
        }): Promise<unknown>;
        pruneReceipts(userId: string, limit: number): Promise<number>;
        clock?: () => Date;
        monotonicNow?: () => number;
        record?(summary: PlayScrobbleMaintenanceSummary): void;
    },
) {
    const clock = dependencies.clock ?? (() => new Date());
    const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    let cursor: { expiresAt: Date; userId: string } | undefined;
    return async () => {
        const started = monotonicNow();
        const withinBudget = () => monotonicNow() - started < 15_000;
        const now = clock();
        const summary: PlayScrobbleMaintenanceSummary = {
            recovered: 0,
            expired: 0,
            enqueued: 0,
            enqueueFailures: 0,
            receipts: 0,
            purged: 0,
            oldestDueSeconds: 0,
            durationMs: 0,
        };
        const stale = await database.playScrobbleDispatch.findMany({
            where: { state: "CLAIMED", claimExpiresAt: { lte: now } },
            orderBy: [{ claimExpiresAt: "asc" }, { id: "asc" }],
            take: 100,
            select: { id: true },
        });
        if (stale.length && withinBudget())
            summary.recovered = (
                await database.$transaction(
                    (transaction) =>
                        transaction.playScrobbleDispatch.updateMany({
                            where: {
                                id: { in: stale.map((row) => row.id) },
                                state: "CLAIMED",
                                claimExpiresAt: { lte: now },
                            },
                            data: {
                                state: "AMBIGUOUS",
                                reason: "claim_expired",
                                completedAt: now,
                                metadata: Prisma.DbNull,
                                claimToken: null,
                                claimExpiresAt: null,
                            },
                        }),
                    { maxWait: 5_000, timeout: 5_000 },
                )
            ).count;
        if (withinBudget()) {
            const expired = await database.playScrobbleDispatch.findMany({
                where: { state: "PENDING", expiresAt: { lte: now } },
                orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
                take: 100,
                select: { id: true },
            });
            if (expired.length && withinBudget())
                summary.expired = (
                    await database.$transaction(
                        (transaction) =>
                            transaction.playScrobbleDispatch.updateMany({
                                where: {
                                    id: { in: expired.map((row) => row.id) },
                                    state: "PENDING",
                                    expiresAt: { lte: now },
                                },
                                data: {
                                    state: "CANCELLED",
                                    reason: "expired",
                                    completedAt: now,
                                    metadata: Prisma.DbNull,
                                },
                            }),
                        { maxWait: 5_000, timeout: 5_000 },
                    )
                ).count;
        }
        if (withinBudget()) {
            const expiredBefore = new Date(now.getTime() - 300_000);
            const discovery = await database.playCreationReceipt.findMany({
                where: {
                    expiresAt: { lt: expiredBefore },
                    ...(cursor
                        ? {
                              OR: [
                                  { expiresAt: { gt: cursor.expiresAt } },
                                  {
                                      expiresAt: cursor.expiresAt,
                                      userId: { gt: cursor.userId },
                                  },
                              ],
                          }
                        : {}),
                },
                orderBy: [{ expiresAt: "asc" }, { userId: "asc" }],
                take: 100,
                select: { userId: true, expiresAt: true },
            });
            if (!discovery.length) cursor = undefined;
            const owners = [
                ...new Set(discovery.map((row) => row.userId)),
            ].slice(0, 10);
            for (const userId of owners) {
                if (!withinBudget() || summary.receipts >= 100) break;
                const last = [...discovery]
                    .reverse()
                    .find((row) => row.userId === userId)!;
                cursor = last;
                summary.receipts += await dependencies.pruneReceipts(
                    userId,
                    100 - summary.receipts,
                );
            }
        }
        if (withinBudget()) {
            const terminal = await database.playScrobbleDispatch.findMany({
                where: {
                    state: { notIn: ["PENDING", "CLAIMED"] },
                    expiresAt: { lt: new Date(now.getTime() - 300_000) },
                },
                orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
                take: 100,
                select: { id: true },
            });
            if (terminal.length && withinBudget())
                summary.purged = (
                    await database.$transaction(
                        (transaction) =>
                            transaction.playScrobbleDispatch.deleteMany({
                                where: {
                                    id: { in: terminal.map((row) => row.id) },
                                    state: { notIn: ["PENDING", "CLAIMED"] },
                                },
                            }),
                        { maxWait: 5_000, timeout: 5_000 },
                    )
                ).count;
        }
        // Retention must run before hints: even successful Redis commands can consume the tick budget.
        if (withinBudget()) {
            const due = await database.playScrobbleDispatch.findMany({
                where: {
                    state: "PENDING",
                    availableAt: { lte: now },
                    expiresAt: { gt: now },
                },
                orderBy: [{ availableAt: "asc" }, { id: "asc" }],
                take: 100,
                select: { id: true, userId: true, availableAt: true },
            });
            summary.oldestDueSeconds = due.length
                ? Math.max(
                      0,
                      (now.getTime() - due[0].availableAt.getTime()) / 1000,
                  )
                : 0;
            for (const row of due) {
                if (!withinBudget()) break;
                try {
                    await dependencies.enqueue({
                        version: 1,
                        dispatchId: row.id,
                        userId: row.userId,
                    });
                    summary.enqueued++;
                } catch {
                    summary.enqueueFailures++;
                    // A hint failure is global to this connection; leave the remaining hints for the next tick.
                    break;
                }
            }
        }
        summary.durationMs = Math.max(0, monotonicNow() - started);
        dependencies.record?.(summary);
        return summary;
    };
}
