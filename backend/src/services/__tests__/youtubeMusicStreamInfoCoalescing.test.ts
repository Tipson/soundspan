import http from "node:http";

const mockClient = { get: jest.fn() };

jest.mock("../../config", () => ({
    config: { ytmusicStreamer: { url: "http://127.0.0.1:8586" } },
}));
jest.mock("axios", () => ({
    __esModule: true,
    default: { create: () => mockClient },
}));
jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

import { ytMusicService } from "../youtubeMusic";

describe("YouTube stream metadata in-flight requests", () => {
    beforeEach(() => {
        mockClient.get.mockReset();
        jest.useRealTimers();
    });

    afterEach(() => jest.useRealTimers());

    it("sends one actual loopback HTTP request for 100 compatible callers", async () => {
        const requestUrls: Array<string | undefined> = [];
        const server = http.createServer((request, response) => {
            requestUrls.push(request.url);
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ videoId: "http-video", abr: 160 }));
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string")
            throw new Error("Expected TCP address");
        const actualAxios = jest.requireActual<{
            default: import("axios").AxiosStatic;
        }>("axios").default;
        const agent = new http.Agent({ keepAlive: false });
        const client = actualAxios.create({
            baseURL: `http://127.0.0.1:${address.port}`,
            httpAgent: agent,
            timeout: 2000,
            maxRedirects: 0,
        });
        mockClient.get.mockImplementation((path, options) =>
            client.get(path, options),
        );
        try {
            const results = await Promise.all(
                Array.from({ length: 100 }, () =>
                    ytMusicService.getStreamInfo(
                        "__public__",
                        "http-video",
                        "HIGH",
                    ),
                ),
            );
            expect(results).toHaveLength(100);
            expect(results.every((result) => result.abr === 160)).toBe(true);
            expect(requestUrls).toEqual([
                "/stream/http-video?user_id=__public__&quality=HIGH",
            ]);
        } finally {
            agent.destroy();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("joins 100 identical pending metadata requests but does not retain a settled result", async () => {
        let release!: (value: unknown) => void;
        const pending = new Promise((resolve) => {
            release = resolve;
        });
        mockClient.get.mockReturnValue(pending);
        const calls = Array.from({ length: 100 }, () =>
            ytMusicService.getStreamInfo("__public__", "same-video", "HIGH"),
        );
        await Promise.resolve();
        const requestsWhilePending = mockClient.get.mock.calls.length;
        release({ data: { videoId: "same-video", abr: 160 } });
        expect(await Promise.all(calls)).toHaveLength(100);
        expect(requestsWhilePending).toBe(1);
        await ytMusicService.getStreamInfo("__public__", "same-video", "HIGH");
        expect(mockClient.get).toHaveBeenCalledTimes(2);
    });

    it("separates user, track, quality, cache-only, timeout and retry policies", async () => {
        let release!: (value: unknown) => void;
        mockClient.get.mockReturnValue(
            new Promise((resolve) => {
                release = resolve;
            }),
        );
        const calls = [
            ytMusicService.getStreamInfo("u1", "video", "HIGH"),
            ytMusicService.getStreamInfo("u2", "video", "HIGH"),
            ytMusicService.getStreamInfo("u1", "other-video", "HIGH"),
            ytMusicService.getStreamInfo("u1", "video", "LOW"),
            ytMusicService.getStreamInfo("u1", "video", "HIGH", {
                cachedOnly: true,
            }),
            ytMusicService.getStreamInfo("u1", "video", "HIGH", {
                timeoutMs: 5_000,
            }),
            ytMusicService.getStreamInfo("u1", "video", "HIGH", {
                maxRetries: 0,
            }),
        ];
        await Promise.resolve();
        const requestsWhilePending = mockClient.get.mock.calls.length;
        release({ data: { abr: 160 } });
        await Promise.all(calls);
        expect(requestsWhilePending).toBe(7);
    });

    it("shares one retry chain and clears failures before the next attempt", async () => {
        jest.useFakeTimers();
        const failure = {
            response: { status: 503, headers: { "retry-after": "1" } },
        };
        mockClient.get.mockRejectedValue(failure);
        const calls = Array.from({ length: 10 }, () =>
            ytMusicService.getStreamInfo("u1", "failure-video", "HIGH", {
                maxRetries: 1,
            }),
        );
        const settled = Promise.allSettled(calls);
        await jest.advanceTimersByTimeAsync(1000);
        expect(await settled).toEqual(
            Array.from({ length: 10 }, () => ({
                status: "rejected",
                reason: failure,
            })),
        );
        expect(mockClient.get).toHaveBeenCalledTimes(2);
        mockClient.get.mockResolvedValue({ data: { abr: 192 } });
        await expect(
            ytMusicService.getStreamInfo("u1", "failure-video", "HIGH", {
                maxRetries: 1,
            }),
        ).resolves.toEqual({ abr: 192 });
        expect(mockClient.get).toHaveBeenCalledTimes(3);
    });

    it("gives each caller its own metadata value and snapshots mutable options", async () => {
        mockClient.get.mockResolvedValue({
            data: { abr: 160, videoId: "snapshot" },
        });
        const options = { cachedOnly: true, timeoutMs: 5_000, maxRetries: 0 };
        const first = ytMusicService.getStreamInfo(
            "u1",
            "snapshot",
            "HIGH",
            options,
        );
        const second = ytMusicService.getStreamInfo("u1", "snapshot", "HIGH", {
            ...options,
        });
        options.cachedOnly = false;
        options.timeoutMs = 99_000;
        const [a, b] = await Promise.all([first, second]);
        expect(mockClient.get).toHaveBeenCalledTimes(1);
        expect(mockClient.get).toHaveBeenCalledWith("/stream/snapshot", {
            params: { user_id: "u1", quality: "HIGH", cached_only: "true" },
            timeout: 5_000,
        });
        a.abr = 1;
        expect(b.abr).toBe(160);
    });

    it("caps tracked flights without rejecting overflow or losing existing joins", async () => {
        let release!: (value: unknown) => void;
        mockClient.get.mockReturnValue(
            new Promise((resolve) => {
                release = resolve;
            }),
        );
        const calls = Array.from({ length: 1000 }, (_, index) =>
            ytMusicService.getStreamInfo("u1", `bounded-${index}`),
        );
        calls.push(ytMusicService.getStreamInfo("u1", "bounded-0"));
        calls.push(ytMusicService.getStreamInfo("u1", "overflow"));
        calls.push(ytMusicService.getStreamInfo("u1", "overflow"));
        await Promise.resolve();
        const requestsWhilePending = mockClient.get.mock.calls.length;
        release({ data: { abr: 160 } });
        expect(await Promise.all(calls)).toHaveLength(1003);
        expect(requestsWhilePending).toBe(1002);
        mockClient.get.mockClear();
        await Promise.all([
            ytMusicService.getStreamInfo("u1", "overflow"),
            ytMusicService.getStreamInfo("u1", "overflow"),
        ]);
        expect(mockClient.get).toHaveBeenCalledTimes(1);
    });
});
