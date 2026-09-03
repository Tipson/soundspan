jest.mock("../../../utils/db", () => ({
    prisma: { play: { findMany: jest.fn() } },
}));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn(), info: jest.fn() }) },
}));
jest.mock("../remoteAnalysisHotSet", () => ({
    remoteAnalysisHotSetScheduler: { schedule: jest.fn() },
}));

import { RemoteAnalysisHotSetSweep } from "../remoteAnalysisHotSetSweep";
import { prisma } from "../../../utils/db";
import { remoteAnalysisHotSetScheduler } from "../remoteAnalysisHotSet";
import {
    startRemoteAnalysisHotSetSweep,
    stopRemoteAnalysisHotSetSweep,
} from "../remoteAnalysisHotSetSweep";

afterEach(() => {
    stopRemoteAnalysisHotSetSweep();
    jest.restoreAllMocks();
});

describe("remote analysis account hot-set sweep", () => {
    it("schedules each recently active account without requiring a foreground feed", async () => {
        const scheduleUser = jest.fn().mockResolvedValue(undefined);
        const sweep = new RemoteAnalysisHotSetSweep({
            loadActiveUserIds: jest.fn().mockResolvedValue(["alice", "bob"]),
            scheduleUser,
        });

        await expect(sweep.runOnce()).resolves.toBe(2);

        expect(scheduleUser.mock.calls).toEqual([["alice"], ["bob"]]);
    });

    it("isolates one account failure and continues the bounded pass", async () => {
        const scheduleUser = jest
            .fn()
            .mockRejectedValueOnce(new Error("account unavailable"))
            .mockResolvedValueOnce(undefined);
        const sweep = new RemoteAnalysisHotSetSweep({
            loadActiveUserIds: jest.fn().mockResolvedValue(["alice", "bob"]),
            scheduleUser,
        });

        await expect(sweep.runOnce()).resolves.toBe(1);
        expect(scheduleUser).toHaveBeenCalledTimes(2);
    });

    it("starts once, schedules unique recent accounts and stops once", async () => {
        const interval = { unref: jest.fn() } as unknown as NodeJS.Timeout;
        const setIntervalSpy = jest
            .spyOn(global, "setInterval")
            .mockReturnValue(interval);
        const clearIntervalSpy = jest
            .spyOn(global, "clearInterval")
            .mockImplementation(() => undefined);
        (prisma.play.findMany as jest.Mock).mockResolvedValue([
            { userId: "alice" },
            { userId: "alice" },
            { userId: "bob" },
        ]);
        (remoteAnalysisHotSetScheduler.schedule as jest.Mock).mockResolvedValue(
            undefined,
        );

        startRemoteAnalysisHotSetSweep();
        startRemoteAnalysisHotSetSweep();
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(setIntervalSpy).toHaveBeenCalledTimes(1);
        expect(interval.unref).toHaveBeenCalledTimes(1);
        expect(remoteAnalysisHotSetScheduler.schedule).toHaveBeenCalledTimes(2);
        expect(prisma.play.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                orderBy: { playedAt: "desc" },
                take: 1_000,
                select: { userId: true },
            }),
        );

        stopRemoteAnalysisHotSetSweep();
        stopRemoteAnalysisHotSetSweep();
        expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it("contains a database failure in the supervised background pass", async () => {
        const interval = { unref: jest.fn() } as unknown as NodeJS.Timeout;
        jest.spyOn(global, "setInterval").mockReturnValue(interval);
        jest.spyOn(global, "clearInterval").mockImplementation(() => undefined);
        (prisma.play.findMany as jest.Mock).mockRejectedValue(
            new Error("database unavailable"),
        );

        startRemoteAnalysisHotSetSweep();
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(remoteAnalysisHotSetScheduler.schedule).not.toHaveBeenCalled();
    });

    it("does not overlap periodic passes while the previous pass is running", async () => {
        const interval = { unref: jest.fn() } as unknown as NodeJS.Timeout;
        const setIntervalSpy = jest
            .spyOn(global, "setInterval")
            .mockReturnValue(interval);
        jest.spyOn(global, "clearInterval").mockImplementation(() => undefined);
        let resolveRows!: (rows: Array<{ userId: string }>) => void;
        (prisma.play.findMany as jest.Mock).mockReturnValue(
            new Promise((resolve) => {
                resolveRows = resolve;
            }),
        );

        startRemoteAnalysisHotSetSweep();
        const intervalHandler = setIntervalSpy.mock.calls[0]?.[0];
        expect(typeof intervalHandler).toBe("function");
        if (typeof intervalHandler === "function") intervalHandler();
        await Promise.resolve();

        expect(prisma.play.findMany).toHaveBeenCalledTimes(1);
        resolveRows([]);
        await new Promise<void>((resolve) => setImmediate(resolve));
    });
});
