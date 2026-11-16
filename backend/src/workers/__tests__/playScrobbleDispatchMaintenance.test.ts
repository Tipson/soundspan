describe("Play dispatch maintenance lifecycle", () => {
    test("slow successful hints cannot starve database retention on successive ticks", async () => {
        const {
            createPlayScrobbleMaintenance,
        } = require("../playScrobbleDispatchMaintenance");
        let elapsed = 0;
        const now = new Date(1_800_000_000_000);
        const database: any = {
            $transaction: (callback: (transaction: unknown) => unknown) =>
                callback(database),
            playScrobbleDispatch: {
                findMany: async ({ where }: any) =>
                    where.state === "PENDING" && where.availableAt
                        ? Array.from({ length: 100 }, (_, index) => ({
                              id: `due-${index}`,
                              userId: "owner",
                              availableAt: new Date(now.getTime() - 10_000),
                          }))
                        : where.state?.notIn
                          ? [{ id: "terminal" }]
                          : [],
                deleteMany: async () => ({ count: 1 }),
            },
            playCreationReceipt: {
                findMany: async () => [
                    {
                        userId: "owner",
                        expiresAt: new Date(now.getTime() - 400_000),
                    },
                ],
            },
        };
        const pruneReceipts = jest.fn().mockResolvedValue(1);
        const tick = createPlayScrobbleMaintenance(database, {
            clock: () => now,
            monotonicNow: () => elapsed,
            enqueue: async () => {
                elapsed += 1_900;
            },
            pruneReceipts,
        });
        for (let index = 0; index < 3; index++)
            expect(await tick()).toMatchObject({ receipts: 1, purged: 1 });
        expect(pruneReceipts).toHaveBeenCalledTimes(3);
    });
    test("a failed Redis hint leaves budget for receipt GC and terminal cleanup", async () => {
        const {
            createPlayScrobbleMaintenance,
        } = require("../playScrobbleDispatchMaintenance");
        const database: any = {
            $transaction: (work: (transaction: unknown) => unknown) =>
                work(database),
            playScrobbleDispatch: {
                findMany: async ({ where }: any) =>
                    where.state === "CLAIMED"
                        ? [{ id: "stale" }]
                        : where.state === "PENDING" && where.expiresAt?.lte
                          ? [{ id: "expired" }]
                          : where.state?.notIn
                            ? [{ id: "terminal" }]
                            : [
                                  {
                                      id: "due1",
                                      userId: "owner",
                                      availableAt: new Date(Date.now() - 5_000),
                                  },
                                  {
                                      id: "due2",
                                      userId: "owner",
                                      availableAt: new Date(),
                                  },
                              ],
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            playCreationReceipt: {
                findMany: jest.fn().mockResolvedValue([
                    {
                        userId: "owner",
                        expiresAt: new Date(Date.now() - 400_000),
                    },
                ]),
            },
        };
        const enqueue = jest
            .fn()
            .mockRejectedValue(new Error("Redis unavailable"));
        const record = jest.fn();
        const pruneReceipts = jest.fn().mockResolvedValue(1);
        const tick = createPlayScrobbleMaintenance(database, {
            enqueue,
            pruneReceipts,
            record,
        });
        expect(await tick()).toMatchObject({
            recovered: 1,
            expired: 1,
            enqueueFailures: 1,
            enqueued: 0,
            receipts: 1,
            purged: 1,
        });
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(pruneReceipts).toHaveBeenCalledWith("owner", 100);
        expect(record).toHaveBeenCalledTimes(1);
    });
    test("startup and timer ticks are single-flight; stop awaits the active tick", async () => {
        jest.useFakeTimers();
        const {
            createPlayScrobbleMaintenanceLoop,
        } = require("../playScrobbleDispatchMaintenance");
        let finish!: () => void;
        const tick = jest.fn(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        const loop = createPlayScrobbleMaintenanceLoop(tick, jest.fn());
        loop.start();
        await Promise.resolve();
        expect(tick).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(180_000);
        expect(tick).toHaveBeenCalledTimes(1);
        let stopped = false;
        const stop = loop.stop().then(() => {
            stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        finish();
        await stop;
        jest.advanceTimersByTime(180_000);
        expect(tick).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
    });

    test("a failed startup tick is observed and the next interval recovers", async () => {
        jest.useFakeTimers();
        const {
            createPlayScrobbleMaintenanceLoop,
        } = require("../playScrobbleDispatchMaintenance");
        const failure = jest.fn();
        const tick = jest
            .fn()
            .mockRejectedValueOnce(new Error("synthetic"))
            .mockResolvedValue(undefined);
        const loop = createPlayScrobbleMaintenanceLoop(tick, failure);
        loop.start();
        await jest.advanceTimersByTimeAsync(60_000);
        expect(failure).toHaveBeenCalledTimes(1);
        expect(tick).toHaveBeenCalledTimes(2);
        await loop.stop();
        jest.useRealTimers();
    });
});
