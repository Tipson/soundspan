const mockEval = jest.fn();
const mockRedis = {
    isReady: true,
    withAbortSignal: jest.fn(() => ({ eval: mockEval })),
};
jest.mock("../../utils/redis", () => ({ redisClient: mockRedis }));
import { runMusicBrainzRequest } from "../musicbrainzRequestGate";

describe("shared MusicBrainz admission", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        mockEval.mockReset();
        mockRedis.isReady = true;
    });
    afterEach(() => jest.useRealTimers());

    it("paces distinct callers using one shared slot before dispatch", async () => {
        let next = 0;
        mockEval.mockImplementation(async (_script, options) => {
            if (Date.now() < next) return next - Date.now();
            next = Date.now() + Number(options.arguments[0]);
            return 0;
        });
        const starts: number[] = [];
        const work = () =>
            runMusicBrainzRequest(async () => {
                starts.push(Date.now());
                return "ok";
            });
        const result = Promise.all([work(), work()]);
        await jest.advanceTimersByTimeAsync(2300);
        expect(await result).toEqual(["ok", "ok"]);
        expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1100);
    });

    it("defers requests during an upstream cooldown without dispatch or sleep", async () => {
        mockEval.mockResolvedValue(30_000);
        const work = jest.fn();
        await expect(runMusicBrainzRequest(work)).rejects.toThrow("deferred");
        expect(work).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });

    it("records one shared cooldown after a 503 and preserves the original failure", async () => {
        mockEval.mockResolvedValue(0);
        const failure = {
            response: { status: 503, headers: { "retry-after": "0" } },
        };
        await expect(
            runMusicBrainzRequest(async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);
        expect(mockEval).toHaveBeenCalledTimes(2);
        expect(mockEval.mock.calls[1][1].arguments).toEqual(["30000"]);
    });

    it("fails closed when shared admission cannot be checked", async () => {
        mockRedis.isReady = false;
        const work = jest.fn();
        await expect(runMusicBrainzRequest(work)).rejects.toThrow("deferred");
        expect(work).not.toHaveBeenCalled();
        expect(mockEval).not.toHaveBeenCalled();
    });

    it("bounds a stalled Redis command and never dispatches its late grant", async () => {
        let release!: (value: number) => void;
        mockEval.mockReturnValue(
            new Promise((resolve) => {
                release = resolve;
            }),
        );
        const work = jest.fn();
        const result = runMusicBrainzRequest(work);
        const rejected = expect(result).rejects.toThrow("deferred");
        await jest.advanceTimersByTimeAsync(500);
        await rejected;
        release(0);
        await Promise.resolve();
        expect(work).not.toHaveBeenCalled();
    });

    it("preserves spacing when the first grant takes 400ms to arrive", async () => {
        let next = 0;
        let grants = 0;
        mockEval.mockImplementation(async (_script, options) => {
            if (Date.now() < next) return next - Date.now();
            next = Date.now() + Number(options.arguments[0]);
            if (++grants === 1)
                await new Promise((resolve) => setTimeout(resolve, 400));
            return 0;
        });
        const starts: number[] = [];
        const work = () =>
            runMusicBrainzRequest(async () => {
                starts.push(Date.now());
                return "ok";
            });
        const result = Promise.allSettled([work(), work()]);
        await jest.advanceTimersByTimeAsync(2200);
        expect(await result).toEqual([
            { status: "fulfilled", value: "ok" },
            { status: "fulfilled", value: "ok" },
        ]);
        expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
    });
});
