const mockEval = jest.fn();
const mockRedis = {
    isReady: true,
    withAbortSignal: jest.fn(() => ({ eval: mockEval })),
};
jest.mock("../../utils/redis", () => ({ redisClient: mockRedis }));
import { runMusicBrainzRequest } from "../musicbrainzRequestGate";
import { rateLimiter } from "../rateLimiter";

jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), warn: jest.fn() },
}));
jest.mock("p-queue", () => ({
    __esModule: true,
    default: class {
        add = (request: () => Promise<unknown>) => request();
        onIdle = async () => undefined;
    },
}));

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

    it.each(["seconds", "HTTP-date"])(
        "honors %s Retry-After beyond one minute",
        async (format) => {
            mockEval.mockResolvedValue(0);
            const retryAfter =
                format === "seconds"
                    ? "120"
                    : new Date(Date.now() + 120_000).toUTCString();
            const failure = {
                response: {
                    status: 503,
                    headers: { "retry-after": retryAfter },
                },
            };
            await expect(
                runMusicBrainzRequest(async () => {
                    throw failure;
                }),
            ).rejects.toBe(failure);
            expect(
                Number(mockEval.mock.calls[1][1].arguments[0]),
            ).toBeGreaterThanOrEqual(119_000);
        },
    );

    it.each(["garbage", "9".repeat(400), -1, undefined])(
        "uses the existing cooldown for an invalid Retry-After %j",
        async (retryAfter) => {
            mockEval.mockResolvedValue(0);
            const failure = {
                response: {
                    status: 429,
                    headers: { "retry-after": retryAfter },
                },
            };
            await expect(
                runMusicBrainzRequest(async () => {
                    throw failure;
                }),
            ).rejects.toBe(failure);
            expect(mockEval.mock.calls[1][1].arguments).toEqual(["30000"]);
        },
    );

    it("bounds an otherwise valid long provider cooldown", async () => {
        mockEval.mockResolvedValue(0);
        const failure = {
            response: { status: 503, headers: { "retry-after": "172800" } },
        };
        await expect(
            runMusicBrainzRequest(async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);
        expect(mockEval.mock.calls[1][1].arguments).toEqual(["86400000"]);
    });

    it.each([
        "ERR_CANCELED",
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "INVALID_ARGUMENT",
    ])(
        "preserves %s without putting unrelated callers into an outage cooldown",
        async (code) => {
            mockEval.mockResolvedValue(0);
            const failure = Object.assign(
                new Error("permanent or caller-owned failure"),
                { code },
            );
            await expect(
                runMusicBrainzRequest(async () => {
                    throw failure;
                }),
            ).rejects.toBe(failure);
            expect(mockEval).toHaveBeenCalledTimes(1);
        },
    );

    it("preserves the TLS reset when writing its cooldown also fails", async () => {
        mockEval
            .mockResolvedValueOnce(0)
            .mockRejectedValueOnce(new Error("Redis unavailable"));
        const failure = Object.assign(new Error("TLS reset"), {
            code: "ECONNRESET",
        });
        await expect(
            runMusicBrainzRequest(async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);
        expect(mockEval).toHaveBeenCalledTimes(2);
    });

    it("defers queued and retried lookups after a TLS reset, then recovers after the shared cooldown", async () => {
        let next = 0;
        mockEval.mockImplementation(async (_script, options) => {
            const delay = Number(options.arguments[0]);
            if (delay <= 1600 && Date.now() < next) return next - Date.now();
            next = Math.max(next, Date.now() + delay);
            return 0;
        });
        const failure = Object.assign(
            new Error(
                "Client network socket disconnected before secure TLS connection was established",
            ),
            { code: "ECONNRESET" },
        );
        const http = jest.fn().mockRejectedValue(failure);
        const lookup = () =>
            rateLimiter.execute("musicbrainz", () =>
                runMusicBrainzRequest(http),
            );
        const results = Promise.allSettled([lookup(), lookup()]);
        await jest.advanceTimersByTimeAsync(29_999);
        expect(http).toHaveBeenCalledTimes(1);
        expect(await results).toEqual([
            {
                status: "rejected",
                reason: expect.objectContaining({
                    message: expect.stringContaining("deferred"),
                }),
            },
            {
                status: "rejected",
                reason: expect.objectContaining({
                    message: expect.stringContaining("deferred"),
                }),
            },
        ]);
        await jest.advanceTimersByTimeAsync(2);
        http.mockResolvedValue("recovered");
        await expect(lookup()).resolves.toBe("recovered");
        expect(http).toHaveBeenCalledTimes(2);
        await rateLimiter.drain();
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
