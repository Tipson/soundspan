jest.mock("../../config", () => ({
    config: { streaming: { traceEnabled: false } },
}));

describe("play request evidence with production logging", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv, NODE_ENV: "production" };
        delete process.env.LOG_LEVEL;
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    it("keeps cancellation and late commit visible at the default production level", async () => {
        const warn = jest.spyOn(console, "warn").mockImplementation();
        const info = jest.spyOn(console, "info").mockImplementation();
        const { logPlayRequestStage } = await import("../playbackTrace");
        logPlayRequestStage("playback.play.stage", {
            outcome: "success",
            stage: "validation",
        });
        logPlayRequestStage("playback.play.stage", {
            outcome: "cancelled",
            stage: "request",
            writeState: "inflight",
            attemptId: "anonymous_attempt",
        });
        logPlayRequestStage("playback.play.stage", {
            outcome: "late_success",
            stage: "db_acquire_write",
            writeState: "committed",
            attemptId: "anonymous_attempt",
        });
        expect(info).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls.map((args) => args[2])).toEqual([
            expect.objectContaining({
                outcome: "cancelled",
                writeState: "inflight",
            }),
            expect.objectContaining({
                outcome: "late_success",
                writeState: "committed",
            }),
        ]);
    });

    it("still honors an explicit silent log policy", async () => {
        process.env.LOG_LEVEL = "silent";
        const warn = jest.spyOn(console, "warn").mockImplementation();
        const { logPlayRequestStage } = await import("../playbackTrace");
        logPlayRequestStage("playback.play.stage", {
            outcome: "cancelled",
            stage: "request",
            writeState: "inflight",
        });
        expect(warn).not.toHaveBeenCalled();
    });
});
