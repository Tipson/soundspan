jest.mock("../../../utils/db", () => ({ prisma: {} }));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn(), info: jest.fn() }) },
}));
jest.mock("../remoteAnalysisHotSet", () => ({
    remoteAnalysisHotSetScheduler: { schedule: jest.fn() },
}));

import { RemoteAnalysisHotSetSweep } from "../remoteAnalysisHotSetSweep";

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
});
