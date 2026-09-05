import http from "node:http";
import { PassThrough } from "node:stream";

const mockClient = {
    get: jest.fn(),
    post: jest.fn(),
};

const mockAxiosCreate = jest.fn((_config?: any) => mockClient);

// youtubeMusic.ts now reads config.internalApiSecret; mock config so the real
// module (which process.exit(1)s on missing env) never loads under jest.
const mockConfig: {
    internalApiSecret?: string;
    ytmusicStreamer: { url: string };
} = { ytmusicStreamer: { url: "http://127.0.0.1:8586" } };

jest.mock("../../config", () => ({ config: mockConfig }));

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: (config: any) => mockAxiosCreate(config),
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

import { ytMusicService, normalizeYtMusicStreamQuality } from "../youtubeMusic";
import { logger } from "../../utils/logger";

describe("youtubeMusic service", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
        mockConfig.internalApiSecret = undefined;
        (ytMusicService as any).loadAvailability.clear();
        (ytMusicService as any).radioLoaders.clear();
    });

    it("passes cache-only stream info through without extracting", async () => {
        mockClient.get.mockResolvedValueOnce({ data: { abr: 0 } });
        await ytMusicService.getStreamInfo("__public__", "video-id", "HIGH", {
            cachedOnly: true,
        });
        expect(mockClient.get).toHaveBeenCalledWith("/stream/video-id", {
            params: {
                user_id: "__public__",
                quality: "HIGH",
                cached_only: "true",
            },
        });
    });

    it("forwards tail warmup reconciliation as an abortable JSON-only request", async () => {
        const signal = new AbortController().signal;
        const snapshot = {
            ownerId: "user-1:player-1",
            generation: 7,
            accepted: true,
            items: [
                { videoId: "next0000001", quality: "HIGH", status: "queued" },
            ],
        };
        mockClient.post.mockResolvedValueOnce({ data: snapshot });

        await expect(
            ytMusicService.reconcileTailWarmup(
                {
                    ownerId: "user-1:player-1",
                    generation: 7,
                    quality: "HIGH",
                    current: "current01",
                    immediate: "next01",
                    tail: ["tail0000001"],
                },
                { signal },
            ),
        ).resolves.toEqual(snapshot);
        expect(mockClient.post).toHaveBeenCalledWith(
            "/tail-warmup/reconcile",
            {
                ownerId: "user-1:player-1",
                generation: 7,
                quality: "HIGH",
                current: "current01",
                immediate: "next01",
                tail: ["tail0000001"],
            },
            { signal, timeout: 5_000 },
        );
    });

    describe("internal-secret header (F31)", () => {
        it("attaches x-internal-secret to the sidecar client when configured", () => {
            mockConfig.internalApiSecret = "sek-123";
            jest.isolateModules(() => {
                require("../youtubeMusic");
            });
            expect(mockAxiosCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    headers: expect.objectContaining({
                        "x-internal-secret": "sek-123",
                    }),
                }),
            );
        });

        it("omits the header when no secret is configured (fail-closed at sidecar)", () => {
            mockConfig.internalApiSecret = undefined;
            jest.isolateModules(() => {
                require("../youtubeMusic");
            });
            const createArg = mockAxiosCreate.mock.calls.at(-1)?.[0] ?? {};
            expect(createArg.headers).toBeUndefined();
        });
    });

    it("reserves bounded sidecar transport capacity for interactive listeners", async () => {
        let isolatedService: typeof ytMusicService;
        jest.isolateModules(() => {
            isolatedService = require("../youtubeMusic").ytMusicService;
        });
        const createArg = mockAxiosCreate.mock.calls.at(-1)?.[0];

        expect(createArg.maxRedirects).toBe(0);
        expect(createArg.httpAgent.maxSockets).toBe(16);
        expect(createArg.httpAgent.maxTotalSockets).toBe(16);
        expect(createArg.httpAgent.maxFreeSockets).toBe(8);
        expect(createArg.httpsAgent.maxSockets).toBe(16);
        expect(createArg.httpsAgent.maxTotalSockets).toBe(16);
        expect(createArg.httpsAgent.maxFreeSockets).toBe(8);

        mockClient.get.mockResolvedValue({ data: { pipe: jest.fn() } });
        await isolatedService!.getStreamProxy("u1", "current", "high");
        const interactiveConfig = mockClient.get.mock.calls.at(-1)?.[1];
        await isolatedService!.getStreamProxy("u1", "next", "high", undefined, {
            purpose: "preload",
        });
        const preloadConfig = mockClient.get.mock.calls.at(-1)?.[1];
        await isolatedService!.getStreamProxy(
            "u1",
            "analysis",
            "high",
            undefined,
            { purpose: "analysis" },
        );
        const analysisConfig = mockClient.get.mock.calls.at(-1)?.[1];

        expect(interactiveConfig.httpAgent).not.toBe(createArg.httpAgent);
        expect(interactiveConfig.httpsAgent).not.toBe(createArg.httpsAgent);
        expect(interactiveConfig.httpAgent.maxSockets).toBe(120);
        expect(interactiveConfig.httpAgent.maxTotalSockets).toBe(120);
        expect(interactiveConfig.httpAgent.maxFreeSockets).toBe(16);
        expect(interactiveConfig.httpsAgent.maxSockets).toBe(120);
        expect(interactiveConfig.httpsAgent.maxTotalSockets).toBe(120);
        expect(interactiveConfig.httpsAgent.maxFreeSockets).toBe(16);
        expect(preloadConfig.httpAgent).not.toBe(interactiveConfig.httpAgent);
        expect(preloadConfig.httpsAgent).not.toBe(interactiveConfig.httpsAgent);
        expect(preloadConfig.httpAgent.maxSockets).toBe(8);
        expect(preloadConfig.httpAgent.maxTotalSockets).toBe(8);
        expect(preloadConfig.httpAgent.maxFreeSockets).toBe(4);
        expect(preloadConfig.httpsAgent.maxSockets).toBe(8);
        expect(preloadConfig.httpsAgent.maxTotalSockets).toBe(8);
        expect(preloadConfig.httpsAgent.maxFreeSockets).toBe(4);
        expect(analysisConfig.httpAgent).toBe(preloadConfig.httpAgent);
        expect(analysisConfig.httpsAgent).toBe(preloadConfig.httpsAgent);
        expect(
            createArg.httpAgent.maxSockets +
                interactiveConfig.httpAgent.maxSockets +
                preloadConfig.httpAgent.maxSockets,
        ).toBe(144);
        expect(
            createArg.httpsAgent.maxSockets +
                interactiveConfig.httpsAgent.maxSockets +
                preloadConfig.httpsAgent.maxSockets,
        ).toBe(144);
    });

    it("does not follow sidecar redirects while normal JSON and stream responses work", async () => {
        jest.isolateModules(() => {
            require("../youtubeMusic");
        });
        const createArg = mockAxiosCreate.mock.calls.at(-1)?.[0];
        expect(createArg.adapter).toEqual(expect.any(Function));
        const actualAxios = (
            jest.requireActual("axios") as unknown as {
                default: import("axios").AxiosStatic;
            }
        ).default;
        let redirectedRequests = 0;
        const redirectTarget = http.createServer((_request, response) => {
            redirectedRequests += 1;
            response.end("redirected");
        });
        const sidecar = http.createServer((request, response) => {
            if (request.url === "/json") {
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ ok: true }));
                return;
            }
            if (request.url === "/stream") {
                response.setHeader("content-type", "audio/webm");
                response.end("audio");
                return;
            }
            const status = request.url === "/redirect-307" ? 307 : 302;
            const targetAddress = redirectTarget.address();
            if (!targetAddress || typeof targetAddress === "string") {
                response.statusCode = 500;
                response.end();
                return;
            }
            response.writeHead(status, {
                location: `http://127.0.0.1:${targetAddress.port}/target`,
            });
            response.end();
        });
        const listen = (server: http.Server) =>
            new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
        const close = (server: http.Server) =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });

        await listen(redirectTarget);
        await listen(sidecar);
        const sidecarAddress = sidecar.address();
        if (!sidecarAddress || typeof sidecarAddress === "string") {
            throw new Error("Expected a TCP listener");
        }
        const { adapter: _boundedAdapter, ...transportOptions } = createArg;
        const client = actualAxios.create({
            ...transportOptions,
            baseURL: `http://127.0.0.1:${sidecarAddress.port}`,
        });
        try {
            await expect(client.get("/json")).resolves.toMatchObject({
                status: 200,
                data: { ok: true },
            });
            const streamResponse = await client.get("/stream", {
                responseType: "stream",
            });
            const chunks: Buffer[] = [];
            for await (const chunk of streamResponse.data) {
                chunks.push(Buffer.from(chunk));
            }
            expect(Buffer.concat(chunks).toString("utf8")).toBe("audio");

            await expect(client.get("/redirect-302")).rejects.toMatchObject({
                response: { status: 302 },
            });
            await expect(client.get("/redirect-307")).rejects.toMatchObject({
                response: { status: 307 },
            });
            expect(redirectedRequests).toBe(0);
        } finally {
            createArg.httpAgent.destroy();
            createArg.httpsAgent.destroy();
            await Promise.all([close(sidecar), close(redirectTarget)]);
        }
    });

    it("admits current and control traffic while other transport lanes are saturated", async () => {
        let isolatedService: typeof ytMusicService;
        jest.isolateModules(() => {
            isolatedService = require("../youtubeMusic").ytMusicService;
        });
        const controlAgent = mockAxiosCreate.mock.calls.at(-1)?.[0]
            .httpAgent as http.Agent;

        mockClient.get.mockResolvedValue({ data: { pipe: jest.fn() } });
        await isolatedService!.getStreamProxy("u1", "current", "high");
        const interactiveAgent = mockClient.get.mock.calls.at(-1)?.[1]
            .httpAgent as http.Agent;
        await isolatedService!.getStreamProxy(
            "u1",
            "preload",
            "high",
            undefined,
            { purpose: "preload" },
        );
        const backgroundAgent = mockClient.get.mock.calls.at(-1)?.[1]
            .httpAgent as http.Agent;

        const heldRequests: http.ClientRequest[] = [];
        const heldResponses: http.IncomingMessage[] = [];
        const server = http.createServer((request, response) => {
            if (request.url === "/hold") {
                response.writeHead(200, {
                    "content-type": "audio/webm",
                    "transfer-encoding": "chunked",
                });
                response.flushHeaders();
                return;
            }
            response.end("ok");
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
            throw new Error("Expected a TCP listener");
        }
        const origin = `http://127.0.0.1:${address.port}`;

        const hold = (agent: http.Agent) =>
            new Promise<void>((resolve, reject) => {
                const request = http.get(
                    `${origin}/hold`,
                    { agent },
                    (response) => {
                        heldResponses.push(response);
                        resolve();
                    },
                );
                heldRequests.push(request);
                request.once("error", reject);
            });
        const fast = (agent: http.Agent) =>
            new Promise<void>((resolve, reject) => {
                const request = http.get(
                    `${origin}/fast`,
                    { agent },
                    (response) => {
                        response.resume();
                        response.once("end", () => {
                            clearTimeout(timeout);
                            resolve();
                        });
                    },
                );
                const timeout = setTimeout(() => {
                    request.destroy(
                        new Error("Independent transport lane timed out"),
                    );
                }, 2_000);
                request.once("error", (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            });

        try {
            await Promise.all(
                Array.from({ length: 8 }, () => hold(backgroundAgent)),
            );
            await Promise.all([fast(interactiveAgent), fast(controlAgent)]);

            await Promise.all(
                Array.from({ length: 120 }, () => hold(interactiveAgent)),
            );
            await expect(fast(controlAgent)).resolves.toBeUndefined();
        } finally {
            for (const response of heldResponses) response.destroy();
            for (const request of heldRequests) request.destroy();
            controlAgent.destroy();
            interactiveAgent.destroy();
            backgroundAgent.destroy();
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
        }
    }, 15_000);

    it("bounds background stream admission and removes cancelled waiters", async () => {
        let isolatedService: typeof ytMusicService;
        jest.isolateModules(() => {
            isolatedService = require("../youtubeMusic").ytMusicService;
        });
        const responseStreams: PassThrough[] = [];
        mockClient.get.mockImplementation(
            () =>
                new Promise((resolve) => {
                    setTimeout(() => {
                        const stream = new PassThrough();
                        responseStreams.push(stream);
                        resolve({ data: stream });
                    }, 10);
                }),
        );

        const requestPreload = (index: number, signal?: AbortSignal) =>
            isolatedService!.getStreamProxy(
                "u1",
                `preload-${index}`,
                "high",
                undefined,
                { purpose: "preload", signal },
            );
        const active = Array.from({ length: 8 }, (_unused, index) =>
            requestPreload(index),
        );
        const queued = Array.from({ length: 7 }, (_unused, index) =>
            requestPreload(index + 8),
        );
        const cancelledController = new AbortController();
        const cancelled = requestPreload(15, cancelledController.signal);
        const rejected = requestPreload(16);
        const requests = [...active, ...queued, cancelled, rejected];
        let replacement: ReturnType<typeof requestPreload> | undefined;

        try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(mockClient.get).toHaveBeenCalledTimes(8);
            await expect(rejected).rejects.toMatchObject({
                response: { status: 503 },
            });

            cancelledController.abort();
            await expect(cancelled).rejects.toMatchObject({
                name: "AbortError",
            });
            replacement = requestPreload(17);
            requests.push(replacement);
            expect(mockClient.get).toHaveBeenCalledTimes(8);

            await Promise.all(active);
            for (const stream of responseStreams) stream.destroy();
            await Promise.all([...queued, replacement]);
            expect(mockClient.get).toHaveBeenCalledTimes(16);
            expect(
                mockClient.get.mock.calls.map(([path]) => path),
            ).not.toContain("/proxy/preload-15");
        } finally {
            await new Promise((resolve) => setTimeout(resolve, 20));
            for (const stream of responseStreams) stream.destroy();
            await Promise.allSettled(requests);
            for (const stream of responseStreams) stream.destroy();
        }
    });

    it("expires queued background work within its total request budget", async () => {
        jest.useFakeTimers();
        let isolatedService: typeof ytMusicService;
        jest.isolateModules(() => {
            isolatedService = require("../youtubeMusic").ytMusicService;
        });
        const responseStreams: PassThrough[] = [];
        mockClient.get.mockImplementation(() => {
            const stream = new PassThrough();
            responseStreams.push(stream);
            return Promise.resolve({ data: stream });
        });
        const requestPreload = (
            index: number,
            timeoutMs: number,
            signal?: AbortSignal,
        ) =>
            isolatedService!.getStreamProxy(
                "u1",
                `deadline-${index}`,
                "high",
                undefined,
                { purpose: "preload", timeoutMs, signal },
            );
        const active = Array.from({ length: 8 }, (_unused, index) =>
            requestPreload(index, 5_000),
        );
        const queued = Array.from({ length: 7 }, (_unused, index) =>
            requestPreload(index + 8, 5_000),
        );
        const expired = requestPreload(15, 100);
        const requests = [...active, ...queued, expired];
        let expiredError: unknown;
        void expired.catch((error) => {
            expiredError = error;
        });

        try {
            await Promise.all(active);
            expect(mockClient.get).toHaveBeenCalledTimes(8);

            jest.advanceTimersByTime(100);
            await Promise.resolve();
            await Promise.resolve();
            expect(expiredError).toMatchObject({
                response: { status: 504 },
            });
            expect(
                mockClient.get.mock.calls.map(([path]) => path),
            ).not.toContain("/proxy/deadline-15");

            const replacement = requestPreload(16, 5_000);
            requests.push(replacement);
            const overflow = requestPreload(17, 5_000);
            requests.push(overflow);
            await expect(overflow).rejects.toMatchObject({
                response: { status: 503 },
            });
            expect(mockClient.get).toHaveBeenCalledTimes(8);

            for (const stream of responseStreams.slice(0, 8)) {
                stream.emit("end");
                stream.emit("close");
            }
            await Promise.all([...queued, replacement]);
            expect(mockClient.get).toHaveBeenCalledTimes(16);
        } finally {
            for (const stream of responseStreams) stream.emit("close");
            jest.runOnlyPendingTimers();
            await Promise.allSettled(requests);
            for (const stream of responseStreams) stream.emit("close");
            jest.useRealTimers();
        }
    });

    it("preserves cancellation and release races while passing only the remaining budget", async () => {
        jest.useFakeTimers();
        let isolatedService: typeof ytMusicService;
        jest.isolateModules(() => {
            isolatedService = require("../youtubeMusic").ytMusicService;
        });
        const responseStreams: PassThrough[] = [];
        mockClient.get.mockImplementation(() => {
            const stream = new PassThrough();
            responseStreams.push(stream);
            return Promise.resolve({ data: stream });
        });
        const requestPreload = (
            name: string,
            timeoutMs: number,
            signal?: AbortSignal,
        ) =>
            isolatedService!.getStreamProxy("u1", name, "high", undefined, {
                purpose: "preload",
                timeoutMs,
                signal,
            });
        const active = Array.from({ length: 8 }, (_unused, index) =>
            requestPreload(`race-active-${index}`, 5_000),
        );
        const requests = [...active];

        try {
            await Promise.all(active);
            const cancelledController = new AbortController();
            const cancelled = requestPreload(
                "race-cancelled",
                1_000,
                cancelledController.signal,
            );
            const firstQueued = requestPreload("race-first", 1_000);
            const secondQueued = requestPreload("race-second", 1_000);
            requests.push(cancelled, firstQueued, secondQueued);

            jest.advanceTimersByTime(200);
            cancelledController.abort();
            await expect(cancelled).rejects.toMatchObject({
                name: "AbortError",
            });
            jest.advanceTimersByTime(300);

            responseStreams[0]!.emit("end");
            responseStreams[0]!.emit("close");
            await firstQueued;
            expect(mockClient.get).toHaveBeenCalledTimes(9);
            const firstConfig = mockClient.get.mock.calls.find(
                ([path]) => path === "/proxy/race-first",
            )?.[1];
            expect(firstConfig.timeout).toBeGreaterThan(0);
            expect(firstConfig.timeout).toBeLessThanOrEqual(500);

            jest.advanceTimersByTime(400);
            expect(mockClient.get).toHaveBeenCalledTimes(9);
            responseStreams[1]!.emit(
                "error",
                new Error("simulated upstream stream failure"),
            );
            responseStreams[1]!.emit("close");
            await secondQueued;
            expect(mockClient.get).toHaveBeenCalledTimes(10);
            const secondConfig = mockClient.get.mock.calls.find(
                ([path]) => path === "/proxy/race-second",
            )?.[1];
            expect(secondConfig.timeout).toBeGreaterThan(0);
            expect(secondConfig.timeout).toBeLessThanOrEqual(100);
            expect(
                mockClient.get.mock.calls.map(([path]) => path),
            ).not.toContain("/proxy/race-cancelled");

            jest.advanceTimersByTime(200);
            const afterHeaders = requestPreload("race-after-headers", 1_000);
            requests.push(afterHeaders);
            await Promise.resolve();
            expect(mockClient.get).toHaveBeenCalledTimes(10);
            responseStreams[2]!.emit("end");
            responseStreams[2]!.emit("close");
            await afterHeaders;
            expect(mockClient.get).toHaveBeenCalledTimes(11);
        } finally {
            for (const stream of responseStreams) stream.emit("close");
            jest.runOnlyPendingTimers();
            await Promise.allSettled(requests);
            for (const stream of responseStreams) stream.emit("close");
            jest.useRealTimers();
        }
    });

    it("falls back to the finite default budget for invalid timer values", async () => {
        jest.useFakeTimers();
        let isolatedService: typeof ytMusicService;
        jest.isolateModules(() => {
            isolatedService = require("../youtubeMusic").ytMusicService;
        });
        const responseStreams: PassThrough[] = [];
        mockClient.get.mockImplementation(() => {
            const stream = new PassThrough();
            responseStreams.push(stream);
            return Promise.resolve({ data: stream });
        });

        try {
            for (const [index, timeoutMs] of [
                0,
                Number.NaN,
                Number.POSITIVE_INFINITY,
                Number.NEGATIVE_INFINITY,
                Number.MAX_SAFE_INTEGER,
            ].entries()) {
                await isolatedService!.getStreamProxy(
                    "u1",
                    `invalid-budget-${index}`,
                    "high",
                    undefined,
                    { purpose: "preload", timeoutMs },
                );
                const requestConfig = mockClient.get.mock.calls.at(-1)?.[1];
                expect(requestConfig.timeout).toBe(120_000);
                responseStreams.at(-1)?.emit("end");
                responseStreams.at(-1)?.emit("close");
            }
        } finally {
            for (const stream of responseStreams) stream.emit("close");
            jest.useRealTimers();
        }
    });

    it("checks sidecar availability and handles auth/oath method payloads", async () => {
        mockClient.get.mockResolvedValueOnce({ status: 200 });
        await expect(ytMusicService.isAvailable()).resolves.toBe(true);
        expect(mockClient.get).toHaveBeenCalledWith("/health", {
            timeout: 5000,
        });

        // Reset availability memoization so the next check exercises the failure path.
        (ytMusicService as any).loadAvailability.clear();
        mockClient.get.mockRejectedValueOnce(new Error("down"));
        await expect(ytMusicService.isAvailable()).resolves.toBe(false);

        mockClient.get.mockResolvedValueOnce({
            data: { authenticated: true, reason: "ok" },
        });
        await expect(ytMusicService.getAuthStatus("u1")).resolves.toEqual({
            authenticated: true,
            reason: "ok",
        });
        expect(mockClient.get).toHaveBeenLastCalledWith("/auth/status", {
            params: { user_id: "u1" },
        });

        await ytMusicService.restoreOAuth("u1", '{"access":"a"}');
        expect(mockClient.post).toHaveBeenLastCalledWith(
            "/auth/restore",
            { oauth_json: '{"access":"a"}' },
            { params: { user_id: "u1" } },
        );

        await ytMusicService.clearAuth("u1");
        expect(mockClient.post).toHaveBeenLastCalledWith("/auth/clear", null, {
            params: { user_id: "u1" },
        });

        mockClient.post.mockResolvedValueOnce({
            data: {
                device_code: "dc",
                user_code: "uc",
                verification_url: "https://verify",
                expires_in: 600,
                interval: 5,
            },
        });
        await expect(
            ytMusicService.initiateDeviceAuth("client-id", "client-secret"),
        ).resolves.toEqual(
            expect.objectContaining({
                device_code: "dc",
                user_code: "uc",
            }),
        );

        mockClient.post.mockResolvedValueOnce({
            data: { status: "pending", error: undefined },
        });
        await expect(
            ytMusicService.pollDeviceAuth(
                "u1",
                "client-id",
                "client-secret",
                "dc",
            ),
        ).resolves.toEqual({ status: "pending", error: undefined });
        expect(mockClient.post).toHaveBeenLastCalledWith(
            "/auth/device-code/poll",
            {
                client_id: "client-id",
                client_secret: "client-secret",
                device_code: "dc",
            },
            { params: { user_id: "u1" } },
        );

        await ytMusicService.restoreOAuthWithCredentials(
            "u1",
            '{"token":"x"}',
            "client-id",
            "client-secret",
        );
        expect(mockClient.post).toHaveBeenLastCalledWith(
            "/auth/restore",
            {
                oauth_json: '{"token":"x"}',
                client_id: "client-id",
                client_secret: "client-secret",
            },
            { params: { user_id: "u1" } },
        );

        await ytMusicService.restoreOAuthWithCredentials("u2", '{"token":"y"}');
        expect(mockClient.post).toHaveBeenLastCalledWith(
            "/auth/restore",
            { oauth_json: '{"token":"y"}' },
            { params: { user_id: "u2" } },
        );
    });

    it("normalizes stream quality values from settings and requests", () => {
        expect(normalizeYtMusicStreamQuality("LOW")).toBe("low");
        expect(normalizeYtMusicStreamQuality(" medium ")).toBe("medium");
        expect(normalizeYtMusicStreamQuality("HIGH")).toBe("high");
        expect(normalizeYtMusicStreamQuality("LOSSLESS")).toBe("lossless");
        expect(normalizeYtMusicStreamQuality("ultra")).toBeUndefined();
        expect(normalizeYtMusicStreamQuality(undefined)).toBeUndefined();
    });

    it("retries search for retryable failures and throws non-retryable failures", async () => {
        jest.useFakeTimers();

        mockClient.post
            .mockRejectedValueOnce({
                response: { status: 429, headers: { "retry-after": "1" } },
            })
            .mockResolvedValueOnce({
                data: { results: [{ videoId: "v1" }], total: 1 },
            });

        const searchPromise = ytMusicService.search(
            "u1",
            "test query",
            "songs",
        );
        await jest.advanceTimersByTimeAsync(1000);
        await expect(searchPromise).resolves.toEqual({
            results: [{ videoId: "v1" }],
            total: 1,
        });
        expect(mockClient.post).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalled();

        mockClient.post.mockRejectedValueOnce({ response: { status: 400 } });
        await expect(
            ytMusicService.search("u1", "bad query", "songs"),
        ).rejects.toEqual({ response: { status: 400 } });
    });

    it("maps canonical search results for frontend contract usage", async () => {
        mockClient.post.mockResolvedValueOnce({
            data: {
                results: [
                    {
                        videoId: "vid-1",
                        title: "Song One",
                        artist: "Artist One",
                        type: "song",
                        album: { title: "Album One" },
                        duration_seconds: 201,
                        thumbnails: [{ url: "https://img/1.jpg" }],
                    },
                    {
                        videoId: "vid-video",
                        title: "Artist One Full Concert",
                        artist: "Uploader Channel",
                        type: "video",
                        duration_seconds: 5400,
                    },
                    {
                        videoId: "",
                        title: "Missing video id",
                    },
                ],
                total: 3,
            },
        });

        await expect(
            ytMusicService.searchCanonical("u1", "artist one", "songs", 50),
        ).resolves.toEqual({
            query: "artist one",
            filter: "songs",
            total: 3,
            results: [
                {
                    source: "youtube",
                    provider: "ytmusic",
                    providerTrackId: "vid-1",
                    title: "Song One",
                    artistName: "Artist One",
                    albumTitle: "Album One",
                    durationSec: 201,
                    thumbnailUrl: "https://img/1.jpg",
                    raw: expect.objectContaining({
                        videoId: "vid-1",
                        title: "Song One",
                    }),
                },
            ],
        });
        expect(mockClient.post).toHaveBeenCalledWith(
            "/search",
            { query: "artist one", filter: "songs", limit: 50 },
            { params: { user_id: "u1" } },
        );
    });

    it("normalizes album and artist catalog identities without requiring video ids", async () => {
        mockClient.post
            .mockResolvedValueOnce({
                data: {
                    results: [
                        {
                            type: "album",
                            browseId: "MPREb_album-1",
                            title: "Mezzanine",
                            artist: "Massive Attack",
                            year: "1998",
                            thumbnails: [
                                {
                                    url: "https://img/album-small.jpg",
                                    width: 60,
                                    height: 60,
                                },
                                {
                                    url: "https://img/album.jpg",
                                    width: 544,
                                    height: 544,
                                },
                            ],
                        },
                        {
                            type: "album",
                            title: "Missing browse identity",
                        },
                        {
                            type: "album",
                            browseId: "UCnot-an-album",
                            title: "Artist channel mislabeled as an album",
                            artist: "Not an album",
                        },
                        {
                            type: "album",
                            browseId: "VLPLnot-an-album",
                            title: "Playlist mislabeled as an album",
                            artist: "Uploader",
                        },
                        {
                            type: "album",
                            browseId: "VLOLAK5uy_album-2",
                            title: "Blue Lines",
                            artist: "Massive Attack",
                        },
                        {
                            type: "artist",
                            browseId: "UCnot-an-album",
                            title: "Not an album",
                            artist: "Not an album",
                        },
                    ],
                    total: 2,
                },
            })
            .mockResolvedValueOnce({
                data: {
                    results: [
                        {
                            type: "artist",
                            channelId: "UCmassiveattack",
                            browseId: "UCmassiveattack",
                            title: "Massive Attack",
                            artist: "Massive Attack",
                            thumbnails: [
                                {
                                    url: "https://img/artist-small.jpg",
                                    width: 60,
                                    height: 60,
                                },
                                {
                                    url: "https://img/artist.jpg",
                                    width: 544,
                                    height: 544,
                                },
                            ],
                        },
                        {
                            type: "album",
                            browseId: "MPREb_not-an-artist",
                            title: "Not an artist",
                            artist: "Massive Attack",
                        },
                    ],
                    total: 2,
                },
            });

        await expect(
            ytMusicService.searchCatalog("u1", "massive attack", "albums", 20, {
                timeoutMs: 8_000,
                maxRetries: 0,
            }),
        ).resolves.toEqual({
            query: "massive attack",
            filter: "albums",
            total: 2,
            results: [
                {
                    mediaType: "album",
                    provider: "ytmusic",
                    browseId: "MPREb_album-1",
                    title: "Mezzanine",
                    artistName: "Massive Attack",
                    year: "1998",
                    thumbnailUrl: "https://img/album.jpg",
                    raw: expect.objectContaining({
                        browseId: "MPREb_album-1",
                    }),
                },
                {
                    mediaType: "album",
                    provider: "ytmusic",
                    browseId: "VLOLAK5uy_album-2",
                    title: "Blue Lines",
                    artistName: "Massive Attack",
                    year: null,
                    thumbnailUrl: null,
                    raw: expect.objectContaining({
                        browseId: "VLOLAK5uy_album-2",
                    }),
                },
            ],
        });
        await expect(
            ytMusicService.searchCatalog(
                "u1",
                "massive attack",
                "artists",
                20,
                { timeoutMs: 8_000, maxRetries: 0 },
            ),
        ).resolves.toEqual({
            query: "massive attack",
            filter: "artists",
            total: 2,
            results: [
                {
                    mediaType: "artist",
                    provider: "ytmusic",
                    channelId: "UCmassiveattack",
                    name: "Massive Attack",
                    thumbnailUrl: "https://img/artist.jpg",
                    raw: expect.objectContaining({
                        browseId: "UCmassiveattack",
                    }),
                },
            ],
        });
        expect(mockClient.post).toHaveBeenNthCalledWith(
            1,
            "/search",
            { query: "massive attack", filter: "albums", limit: 20 },
            { params: { user_id: "u1" }, timeout: 8_000 },
        );
        expect(mockClient.post).toHaveBeenNthCalledWith(
            2,
            "/search",
            { query: "massive attack", filter: "artists", limit: 20 },
            { params: { user_id: "u1" }, timeout: 8_000 },
        );
    });

    it("handles browse, stream, and library request shapes", async () => {
        mockClient.get
            .mockResolvedValueOnce({ data: { browseId: "album-1" } })
            .mockResolvedValueOnce({ data: { channelId: "artist-1" } })
            .mockResolvedValueOnce({ data: { videoId: "song-1" } });

        await expect(ytMusicService.getAlbum("u1", "album-1")).resolves.toEqual(
            {
                browseId: "album-1",
            },
        );
        await expect(
            ytMusicService.getArtist("u1", "artist-1"),
        ).resolves.toEqual({
            channelId: "artist-1",
        });
        await expect(ytMusicService.getSong("u1", "song-1")).resolves.toEqual({
            videoId: "song-1",
        });

        jest.useFakeTimers();
        mockClient.get
            .mockRejectedValueOnce({
                response: { status: 429, headers: { "retry-after": "1" } },
            })
            .mockResolvedValueOnce({
                data: {
                    videoId: "vid-1",
                    url: "https://stream",
                    content_type: "audio/webm",
                    duration: 100,
                    abr: 160,
                    acodec: "opus",
                    expires_at: 123,
                },
            });
        const streamInfoPromise = ytMusicService.getStreamInfo(
            "u1",
            "vid-1",
            "high",
        );
        await jest.advanceTimersByTimeAsync(1000);
        await expect(streamInfoPromise).resolves.toEqual(
            expect.objectContaining({ videoId: "vid-1", abr: 160 }),
        );
        expect(mockClient.get).toHaveBeenLastCalledWith("/stream/vid-1", {
            params: { user_id: "u1", quality: "high" },
        });

        mockClient.get.mockResolvedValueOnce({ data: { pipe: jest.fn() } });
        await ytMusicService.getStreamProxy(
            "u1",
            "vid-2",
            "low",
            "bytes=0-512",
        );
        expect(mockClient.get).toHaveBeenLastCalledWith(
            "/proxy/vid-2",
            expect.objectContaining({
                params: {
                    user_id: "u1",
                    quality: "low",
                    purpose: "interactive",
                },
                headers: { Range: "bytes=0-512" },
                responseType: "stream",
                timeout: 120000,
                httpAgent: expect.objectContaining({
                    maxSockets: 120,
                    maxTotalSockets: 120,
                }),
                httpsAgent: expect.objectContaining({
                    maxSockets: 120,
                    maxTotalSockets: 120,
                }),
            }),
        );

        const controller = new AbortController();
        mockClient.get.mockResolvedValueOnce({ data: { pipe: jest.fn() } });
        await ytMusicService.getStreamProxy(
            "u1",
            "vid-3",
            "medium",
            undefined,
            {
                signal: controller.signal,
                timeoutMs: 15_000,
                purpose: "analysis",
            },
        );
        expect(mockClient.get).toHaveBeenLastCalledWith(
            "/proxy/vid-3",
            expect.objectContaining({
                params: {
                    user_id: "u1",
                    quality: "medium",
                    purpose: "analysis",
                },
                headers: {},
                responseType: "stream",
                timeout: 15_000,
                httpAgent: expect.objectContaining({
                    maxSockets: 8,
                    maxTotalSockets: 8,
                }),
                httpsAgent: expect.objectContaining({
                    maxSockets: 8,
                    maxTotalSockets: 8,
                }),
                signal: controller.signal,
            }),
        );

        mockClient.get
            .mockResolvedValueOnce({ data: { songs: [{ id: "s1" }] } })
            .mockResolvedValueOnce({ data: { albums: [{ id: "a1" }] } });
        await expect(ytMusicService.getLibrarySongs("u1", 30)).resolves.toEqual(
            [{ id: "s1" }],
        );
        await expect(
            ytMusicService.getLibraryAlbums("u1", 30),
        ).resolves.toEqual([{ id: "a1" }]);
    });

    it("rejects provider identifiers that could escape a sidecar path", async () => {
        const unsafeIdentifiers = [
            "https://attacker.example/steal",
            "//attacker.example/steal",
            "../admin",
            "%2f%2fattacker.example",
            "album?redirect=https://attacker.example",
        ];

        for (const identifier of unsafeIdentifiers) {
            await expect(
                ytMusicService.getAlbum("u1", identifier),
            ).rejects.toThrow(TypeError);
            await expect(
                ytMusicService.getArtist("u1", identifier),
            ).rejects.toThrow(TypeError);
            await expect(
                ytMusicService.getSong("u1", identifier),
            ).rejects.toThrow(TypeError);
            await expect(
                ytMusicService.getStreamInfo("u1", identifier),
            ).rejects.toThrow(TypeError);
            await expect(
                ytMusicService.getStreamProxy("u1", identifier),
            ).rejects.toThrow(TypeError);
            await expect(
                ytMusicService.getBrowsePlaylist(identifier),
            ).rejects.toThrow(TypeError);
            await expect(
                ytMusicService.getBrowseAlbum(identifier),
            ).rejects.toThrow(TypeError);
        }

        expect(mockClient.get).not.toHaveBeenCalled();
    });

    it("runs batch search and album matching with second-pass fallback", async () => {
        const searchBatchSpy = jest.spyOn(ytMusicService, "searchBatch");
        searchBatchSpy
            .mockResolvedValueOnce([
                {
                    results: [
                        {
                            videoId: "first-match",
                            title: "Track One",
                            artist: "Artist One",
                            type: "song",
                            duration_seconds: 199,
                        },
                    ],
                    total: 1,
                    error: null,
                },
                {
                    results: [],
                    total: 0,
                    error: null,
                },
            ])
            .mockResolvedValueOnce([
                {
                    results: [
                        {
                            videoId: "second-match",
                            title: "Track Two",
                            artists: ["Artist Two"],
                            album: { name: "Album Two" },
                            type: "song",
                            duration: "03:20",
                        },
                    ],
                    total: 1,
                    error: null,
                },
            ]);

        const matches = await ytMusicService.findMatchesForAlbum("u1", [
            {
                artist: "Artist One (feat. X)",
                title: "Track One [Live]",
                albumTitle: "Album One",
                duration: 200,
            },
            {
                artist: "Artist Two",
                title: "Track Two",
                albumTitle: "Album Two",
                duration: 200,
            },
        ]);

        expect(matches).toEqual([
            { videoId: "first-match", title: "Track One", duration: 199 },
            { videoId: "second-match", title: "Track Two", duration: 200 },
        ]);

        expect(searchBatchSpy).toHaveBeenCalledTimes(2);
        const firstBatchQueries = searchBatchSpy.mock.calls[0]?.[1];
        expect(firstBatchQueries).toEqual([
            { query: "Artist One Track One", filter: "songs", limit: 6 },
            { query: "Artist Two Track Two", filter: "songs", limit: 6 },
        ]);
        const fallbackQueries = searchBatchSpy.mock.calls[1]?.[1];
        expect(fallbackQueries).toEqual([
            { query: "Artist Two Track Two Album Two", limit: 8 },
        ]);
        expect(searchBatchSpy.mock.calls[0]?.[2]).toEqual({
            timeoutMs: 150_000,
            maxRetries: 0,
        });
        expect(searchBatchSpy.mock.calls[1]?.[2]).toEqual({
            timeoutMs: 150_000,
            maxRetries: 0,
        });
    });

    it("falls back to individual matching when batch search fails", async () => {
        jest.spyOn(ytMusicService, "searchBatch").mockRejectedValueOnce(
            new Error("batch failed"),
        );
        const findMatchSpy = jest
            .spyOn(ytMusicService, "findMatchForTrack")
            .mockResolvedValueOnce({
                videoId: "m1",
                title: "Song One",
                duration: 210,
            })
            .mockResolvedValueOnce(null);

        const result = await ytMusicService.findMatchesForAlbum("u1", [
            { artist: "A1", title: "Song One", albumTitle: "ALB1" },
            { artist: "A2", title: "Song Two", albumTitle: "ALB2" },
        ]);

        expect(result).toEqual([
            { videoId: "m1", title: "Song One", duration: 210 },
            null,
        ]);
        expect(findMatchSpy).toHaveBeenCalledTimes(2);
    });

    it("bounds individual fallback matching to the sidecar search capacity", async () => {
        const searchBatchSpy = jest
            .spyOn(ytMusicService, "searchBatch")
            .mockRejectedValue(new Error("batch failed"));
        let active = 0;
        let maxActive = 0;
        const findMatchSpy = jest
            .spyOn(ytMusicService, "findMatchForTrack")
            .mockImplementation(async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 5));
                active -= 1;
                return null;
            });

        const [firstResult, secondResult] = await Promise.all([
            ytMusicService.findMatchesForAlbum(
                "u1",
                Array.from({ length: 4 }, (_, index) => ({
                    artist: `First Artist ${index}`,
                    title: `First Track ${index}`,
                })),
            ),
            ytMusicService.findMatchesForAlbum(
                "u2",
                Array.from({ length: 4 }, (_, index) => ({
                    artist: `Second Artist ${index}`,
                    title: `Second Track ${index}`,
                })),
            ),
        ]);

        expect(firstResult).toEqual(Array(4).fill(null));
        expect(secondResult).toEqual(Array(4).fill(null));
        expect(maxActive).toBe(3);
        findMatchSpy.mockRestore();
        searchBatchSpy.mockRestore();
    });

    it("uses tiered matching logic for single-track fallback searches", async () => {
        const searchSpy = jest.spyOn(ytMusicService, "search");
        searchSpy.mockResolvedValueOnce({
            results: [
                {
                    videoId: "good",
                    title: "Song Title",
                    artist: "Exact Artist",
                    duration_seconds: 201,
                    type: "song",
                },
                {
                    videoId: "bad-karaoke",
                    title: "Song Title Karaoke",
                    artist: "Exact Artist",
                    duration_seconds: 201,
                    type: "song",
                },
            ],
            total: 2,
        });

        await expect(
            ytMusicService.findMatchForTrack(
                "u1",
                "Exact Artist",
                "Song Title",
                "Album X",
                200,
            ),
        ).resolves.toEqual({
            videoId: "good",
            title: "Song Title",
            duration: 201,
        });

        searchSpy
            .mockRejectedValueOnce(new Error("filtered failed"))
            .mockResolvedValueOnce({
                results: [
                    { videoId: "wrong", title: "Not It", artist: "Other" },
                ],
                total: 1,
            })
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "third-try",
                        title: "Final Song",
                        artists: ["Right Artist"],
                        duration: "03:45",
                        type: "song",
                        album: "Final Album",
                    },
                ],
                total: 1,
            });

        await expect(
            ytMusicService.findMatchForTrack(
                "u1",
                "Right Artist",
                "Final Song",
                "Final Album",
                225,
            ),
        ).resolves.toEqual({
            videoId: "third-try",
            title: "Final Song",
            duration: 225,
        });

        searchSpy
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "unrelated-1",
                        title: "Completely Different",
                        artist: "Another Artist",
                        type: "song",
                        duration_seconds: 400,
                    },
                    {
                        videoId: "unrelated-2",
                        title: "Also Different",
                        artist: "Not Artist",
                        type: "song",
                        duration_seconds: 420,
                    },
                ],
                total: 2,
            })
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "unrelated-3",
                        title: "Wrong Song",
                        artist: "Someone Else",
                        type: "song",
                        duration_seconds: 500,
                    },
                ],
                total: 1,
            });

        await expect(
            ytMusicService.findMatchForTrack(
                "u1",
                "Artist",
                "Love Song",
                undefined,
                200,
            ),
        ).resolves.toBeNull();
    });

    it("excludes the unavailable video and validates exact alternates before returning one", async () => {
        const searchSpy = jest
            .spyOn(ytMusicService, "search")
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "z0NfI2NeDHI",
                        title: "Radio (Official Video)",
                        artist: "Rammstein",
                        duration_seconds: 275,
                        type: "song",
                    },
                    {
                        videoId: "alternate01",
                        title: "Radio",
                        artist: "Rammstein",
                        duration_seconds: 275,
                        type: "song",
                    },
                    {
                        videoId: "alternate02",
                        title: "Radio (Official Audio)",
                        artist: "Rammstein",
                        duration_seconds: 274,
                        type: "song",
                    },
                ],
                total: 3,
            });
        const streamInfoSpy = jest
            .spyOn(ytMusicService, "getStreamInfo")
            .mockRejectedValueOnce({ response: { status: 451 } })
            .mockResolvedValueOnce({
                videoId: "alternate02",
                url: "https://sidecar.invalid/alternate02",
                content_type: "audio/webm",
                duration: 274,
                abr: 128,
                acodec: "opus",
                expires_at: 1,
            });

        await expect(
            ytMusicService.findPlayableAlternateForTrack("__public__", {
                artist: "Rammstein",
                title: "Rammstein - Radio (Official Video)",
                albumTitle: "Rammstein",
                duration: 275,
                excludedVideoIds: ["z0NfI2NeDHI"],
            }),
        ).resolves.toEqual(
            expect.objectContaining({
                videoId: "alternate02",
                title: "Radio (Official Audio)",
                artist: "Rammstein",
                duration: 274,
            }),
        );

        expect(searchSpy).toHaveBeenCalledWith(
            "__public__",
            "Rammstein Radio",
            "songs",
            12,
            { timeoutMs: 8_000, maxRetries: 0 },
        );
        expect(streamInfoSpy.mock.calls.map((call) => call[1])).toEqual([
            "alternate01",
            "alternate02",
        ]);
        expect(streamInfoSpy).not.toHaveBeenCalledWith(
            expect.anything(),
            "z0NfI2NeDHI",
            expect.anything(),
            expect.anything(),
        );

        searchSpy.mockRestore();
        streamInfoSpy.mockRestore();
    });

    it("accepts the live exact artist-prefixed reupload metadata from a different uploader", async () => {
        const searchSpy = jest
            .spyOn(ytMusicService, "search")
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "LR__DRBbnZw",
                        title: "Rammstein - Radio(Official Video)",
                        artist: "Ну Съиздил",
                        duration_seconds: 291,
                        type: "song",
                    },
                ],
                total: 1,
            });
        const streamInfoSpy = jest
            .spyOn(ytMusicService, "getStreamInfo")
            .mockResolvedValueOnce({
                videoId: "LR__DRBbnZw",
                url: "https://sidecar.invalid/LR__DRBbnZw",
                content_type: "audio/webm",
                duration: 290,
                abr: 128,
                acodec: "opus",
                expires_at: 1,
            });

        await expect(
            ytMusicService.findPlayableAlternateForTrack("__public__", {
                artist: "Rammstein",
                title: "Rammstein - Radio (Official Video)",
                albumTitle: "Rammstein",
                duration: 291,
                excludedVideoIds: ["z0NfI2NeDHI"],
            }),
        ).resolves.toEqual(
            expect.objectContaining({
                videoId: "LR__DRBbnZw",
                title: "Rammstein - Radio (Official Video)",
                artist: "Rammstein",
                duration: 291,
            }),
        );
        expect(streamInfoSpy.mock.calls.map((call) => call[1])).toEqual([
            "LR__DRBbnZw",
        ]);
        searchSpy.mockRestore();
        streamInfoSpy.mockRestore();
    });

    it("supports no-space artist separators and probes exact-artist candidates first", async () => {
        const searchSpy = jest
            .spyOn(ytMusicService, "search")
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "Hk77fdYbxOM",
                        title: "Rammstein- Radio (Audio HQ)",
                        artist: "Topsic",
                        album: "Rammstein",
                        duration_seconds: 277,
                        type: "song",
                    },
                    {
                        videoId: "alternate02",
                        title: "Radio (Official Audio)",
                        artist: "Rammstein",
                        duration_seconds: 274,
                        type: "song",
                    },
                ],
                total: 2,
            });
        const streamInfoSpy = jest
            .spyOn(ytMusicService, "getStreamInfo")
            .mockResolvedValueOnce({
                videoId: "alternate02",
                url: "https://sidecar.invalid/alternate02",
                content_type: "audio/webm",
                duration: 274,
                abr: 128,
                acodec: "opus",
                expires_at: 1,
            });

        await expect(
            ytMusicService.findPlayableAlternateForTrack("__public__", {
                artist: "Rammstein",
                title: "Rammstein - Radio (Official Video)",
                albumTitle: "Rammstein",
                duration: 291,
                excludedVideoIds: ["z0NfI2NeDHI"],
            }),
        ).resolves.toEqual(expect.objectContaining({ videoId: "alternate02" }));
        expect(streamInfoSpy.mock.calls.map((call) => call[1])).toEqual([
            "alternate02",
        ]);
        searchSpy.mockRestore();
        streamInfoSpy.mockRestore();
    });

    it("uses the live no-space artist-prefixed fallback when no exact uploader exists", async () => {
        const searchSpy = jest
            .spyOn(ytMusicService, "search")
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "Hk77fdYbxOM",
                        title: "Rammstein- Radio (Audio HQ)",
                        artist: "Topsic",
                        album: "Rammstein",
                        duration_seconds: 277,
                        type: "song",
                    },
                ],
                total: 1,
            });
        const streamInfoSpy = jest
            .spyOn(ytMusicService, "getStreamInfo")
            .mockResolvedValueOnce({
                videoId: "Hk77fdYbxOM",
                url: "https://sidecar.invalid/Hk77fdYbxOM",
                content_type: "audio/webm",
                duration: 277,
                abr: 128,
                acodec: "opus",
                expires_at: 1,
            });

        await expect(
            ytMusicService.findPlayableAlternateForTrack("__public__", {
                artist: "Rammstein",
                title: "Rammstein - Radio (Official Video)",
                albumTitle: "Rammstein",
                duration: 291,
                excludedVideoIds: ["z0NfI2NeDHI"],
            }),
        ).resolves.toEqual(
            expect.objectContaining({
                videoId: "Hk77fdYbxOM",
                artist: "Rammstein",
                duration: 277,
            }),
        );
        expect(streamInfoSpy.mock.calls.map((call) => call[1])).toEqual([
            "Hk77fdYbxOM",
        ]);
        searchSpy.mockRestore();
        streamInfoSpy.mockRestore();
    });

    it("prefers the live fallback whose version marker and duration match the original", async () => {
        const searchSpy = jest
            .spyOn(ytMusicService, "search")
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "Hk77fdYbxOM",
                        title: "Rammstein- Radio (Audio HQ)",
                        artist: "Topsic",
                        album: "Rammstein",
                        duration_seconds: 277,
                        type: "song",
                    },
                    {
                        videoId: "LR__DRBbnZw",
                        title: "Rammstein - Radio(Official Video)",
                        artist: "Ну Съиздил",
                        duration_seconds: 291,
                        type: "song",
                    },
                ],
                total: 2,
            });
        const streamInfoSpy = jest
            .spyOn(ytMusicService, "getStreamInfo")
            .mockResolvedValueOnce({
                videoId: "LR__DRBbnZw",
                url: "https://sidecar.invalid/LR__DRBbnZw",
                content_type: "audio/webm",
                duration: 290,
                abr: 128,
                acodec: "opus",
                expires_at: 1,
            });

        await expect(
            ytMusicService.findPlayableAlternateForTrack("__public__", {
                artist: "Rammstein",
                title: "Rammstein - Radio (Official Video)",
                albumTitle: "Rammstein",
                duration: 291,
                excludedVideoIds: ["z0NfI2NeDHI"],
            }),
        ).resolves.toEqual(expect.objectContaining({ videoId: "LR__DRBbnZw" }));
        expect(streamInfoSpy.mock.calls.map((call) => call[1])).toEqual([
            "LR__DRBbnZw",
        ]);
        searchSpy.mockRestore();
        streamInfoSpy.mockRestore();
    });

    it("rejects fallback probes whose resolved identity or duration is incompatible", async () => {
        const searchSpy = jest
            .spyOn(ytMusicService, "search")
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "LR__DRBbnZw",
                        title: "Rammstein - Radio(Official Video)",
                        artist: "Ну Съиздил",
                        duration_seconds: 291,
                        type: "song",
                    },
                    {
                        videoId: "Hk77fdYbxOM",
                        title: "Rammstein- Radio (Audio HQ)",
                        artist: "Topsic",
                        duration_seconds: 277,
                        type: "song",
                    },
                ],
                total: 2,
            });
        const streamInfoSpy = jest
            .spyOn(ytMusicService, "getStreamInfo")
            .mockResolvedValueOnce({
                videoId: "LR__DRBbnZw",
                url: "https://sidecar.invalid/LR__DRBbnZw",
                content_type: "audio/webm",
                duration: 3_600,
                abr: 128,
                acodec: "opus",
                expires_at: 1,
            })
            .mockResolvedValueOnce({
                videoId: "different01",
                url: "https://sidecar.invalid/Hk77fdYbxOM",
                content_type: "audio/webm",
                duration: 277,
                abr: 128,
                acodec: "opus",
                expires_at: 1,
            });

        await expect(
            ytMusicService.findPlayableAlternateForTrack("__public__", {
                artist: "Rammstein",
                title: "Rammstein - Radio (Official Video)",
                duration: 291,
                excludedVideoIds: ["z0NfI2NeDHI"],
            }),
        ).resolves.toBeNull();
        expect(streamInfoSpy.mock.calls.map((call) => call[1])).toEqual([
            "LR__DRBbnZw",
            "Hk77fdYbxOM",
        ]);
        searchSpy.mockRestore();
        streamInfoSpy.mockRestore();
    });

    it("rejects mismatched uploaders without a safe exact prefix or with unsafe versions", async () => {
        const searchSpy = jest
            .spyOn(ytMusicService, "search")
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "noprefix001",
                        title: "Radio (Official Video)",
                        artist: "Random Uploader",
                        duration_seconds: 291,
                        type: "song",
                    },
                    ...[
                        ["livebad0001", "Rammstein - Radio (Live)"],
                        ["lyricsbad01", "Rammstein - Radio (Lyrics)"],
                        ["translat001", "Rammstein - Radio (Translation)"],
                        ["karaoke0001", "Rammstein - Radio (Karaoke)"],
                        ["makingof001", "Rammstein - Radio (Making Of)"],
                        ["espanol0001", "Rammstein - Radio (Español)"],
                    ].map(([videoId, title]) => ({
                        videoId,
                        title,
                        artist: "Random Uploader",
                        duration_seconds: 291,
                        type: "song",
                    })),
                    {
                        videoId: "wrongname01",
                        title: "Rammstein - Radio Ga Ga",
                        artist: "Random Uploader",
                        duration_seconds: 291,
                        type: "song",
                    },
                    {
                        videoId: "wrongdur001",
                        title: "Rammstein - Radio (Official Video)",
                        artist: "Random Uploader",
                        duration_seconds: 3_600,
                        type: "song",
                    },
                ],
                total: 9,
            });
        const streamInfoSpy = jest.spyOn(ytMusicService, "getStreamInfo");

        await expect(
            ytMusicService.findPlayableAlternateForTrack("__public__", {
                artist: "Rammstein",
                title: "Rammstein - Radio (Official Video)",
                duration: 291,
                excludedVideoIds: ["z0NfI2NeDHI"],
            }),
        ).resolves.toBeNull();
        expect(streamInfoSpy).not.toHaveBeenCalled();
        searchSpy.mockRestore();
        streamInfoSpy.mockRestore();
    });

    it("bounds alternate validation and returns null when no exact candidate streams", async () => {
        const searchSpy = jest
            .spyOn(ytMusicService, "search")
            .mockResolvedValueOnce({
                results: Array.from({ length: 5 }, (_, index) => ({
                    videoId: `blocked000${index}`,
                    title: "Radio",
                    artist: "Rammstein",
                    duration_seconds: 275 + index,
                    type: "song",
                })),
                total: 5,
            });
        const streamInfoSpy = jest
            .spyOn(ytMusicService, "getStreamInfo")
            .mockRejectedValue({ response: { status: 404 } });

        await expect(
            ytMusicService.findPlayableAlternateForTrack("__public__", {
                artist: "Rammstein",
                title: "Radio",
                duration: 275,
                excludedVideoIds: ["z0NfI2NeDHI"],
            }),
        ).resolves.toBeNull();

        expect(streamInfoSpy).toHaveBeenCalledTimes(3);
        searchSpy.mockRestore();
        streamInfoSpy.mockRestore();
    });

    it("does not validate or return a merely similar alternate", async () => {
        const searchSpy = jest
            .spyOn(ytMusicService, "search")
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "wrongtrack01",
                        title: "Radio Ga Ga",
                        artist: "Queen",
                        duration_seconds: 343,
                        type: "song",
                    },
                ],
                total: 1,
            });
        const streamInfoSpy = jest.spyOn(ytMusicService, "getStreamInfo");

        await expect(
            ytMusicService.findPlayableAlternateForTrack("__public__", {
                artist: "Rammstein",
                title: "Radio",
                duration: 275,
                excludedVideoIds: ["z0NfI2NeDHI"],
            }),
        ).resolves.toBeNull();

        expect(streamInfoSpy).not.toHaveBeenCalled();
        searchSpy.mockRestore();
        streamInfoSpy.mockRestore();
    });

    it("does not probe malformed or duration-incompatible exact candidates", async () => {
        const searchSpy = jest
            .spyOn(ytMusicService, "search")
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "malformed",
                        title: "Radio",
                        artist: "Rammstein",
                        duration_seconds: 275,
                        type: "song",
                    },
                    {
                        videoId: "wrongdur001",
                        title: "Radio",
                        artist: "Rammstein",
                        duration_seconds: 3_600,
                        type: "song",
                    },
                ],
                total: 2,
            });
        const streamInfoSpy = jest
            .spyOn(ytMusicService, "getStreamInfo")
            .mockResolvedValue({
                videoId: "malformed",
                url: "https://sidecar.invalid/malformed",
                content_type: "audio/webm",
                duration: 275,
                abr: 128,
                acodec: "opus",
                expires_at: 1,
            });

        await expect(
            ytMusicService.findPlayableAlternateForTrack("__public__", {
                artist: "Rammstein",
                title: "Radio",
                duration: 275,
                excludedVideoIds: ["z0NfI2NeDHI"],
            }),
        ).resolves.toBeNull();

        expect(streamInfoSpy).not.toHaveBeenCalled();
        searchSpy.mockRestore();
        streamInfoSpy.mockRestore();
    });

    it("treats version markers as words rather than title substrings", async () => {
        const searchSpy = jest
            .spyOn(ytMusicService, "search")
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "livevers001",
                        title: "Deliverance (Live)",
                        artist: "Opeth",
                        duration_seconds: 830,
                        type: "song",
                    },
                ],
                total: 1,
            });
        const streamInfoSpy = jest
            .spyOn(ytMusicService, "getStreamInfo")
            .mockResolvedValue({
                videoId: "livevers001",
                url: "https://sidecar.invalid/livevers001",
                content_type: "audio/webm",
                duration: 830,
                abr: 128,
                acodec: "opus",
                expires_at: 1,
            });

        await expect(
            ytMusicService.findPlayableAlternateForTrack("__public__", {
                artist: "Opeth",
                title: "Deliverance",
                duration: 830,
                excludedVideoIds: ["original001"],
            }),
        ).resolves.toBeNull();

        expect(streamInfoSpy).not.toHaveBeenCalled();
        searchSpy.mockRestore();
        streamInfoSpy.mockRestore();
    });

    it("parses numeric candidate duration values when duration_seconds is absent", async () => {
        const searchSpy = jest.spyOn(ytMusicService, "search");
        searchSpy.mockResolvedValueOnce({
            results: [
                {
                    videoId: "dur-num",
                    title: "Exact Track",
                    artist: "Exact Artist",
                    duration: 212,
                    type: "song",
                },
            ],
            total: 1,
        });

        await expect(
            ytMusicService.findMatchForTrack(
                "u1",
                "Exact Artist",
                "Exact Track",
                undefined,
                210,
            ),
        ).resolves.toEqual({
            videoId: "dur-num",
            title: "Exact Track",
            duration: 212,
        });
    });

    it("applies jittered exponential backoff when Retry-After header is missing", async () => {
        jest.useFakeTimers();
        const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0);
        mockClient.post
            .mockRejectedValueOnce({ response: { status: 500 } })
            .mockResolvedValueOnce({
                data: { results: [{ videoId: "v1" }], total: 1 },
            });

        const searchPromise = ytMusicService.search("u1", "timeoutless");

        await jest.advanceTimersByTimeAsync(750);
        await expect(searchPromise).resolves.toEqual({
            results: [{ videoId: "v1" }],
            total: 1,
        });
        expect(mockClient.post).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalled();
        expect(logger.warn).toHaveBeenLastCalledWith(
            "[YTMusic] search(timeoutless) failed (status=500, attempt=1/3), retrying in 750ms",
        );
        randomSpy.mockRestore();
    });

    it("retries on retryable network errors such as ECONNRESET", async () => {
        jest.useFakeTimers();
        const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);
        mockClient.post
            .mockRejectedValueOnce({ code: "ECONNRESET" })
            .mockResolvedValueOnce({
                data: { results: [{ videoId: "v2" }], total: 1 },
            });

        const searchPromise = ytMusicService.search("u1", "network-flaky");
        await jest.advanceTimersByTimeAsync(1000);
        await expect(searchPromise).resolves.toEqual({
            results: [{ videoId: "v2" }],
            total: 1,
        });
        expect(mockClient.post).toHaveBeenCalledTimes(2);
        randomSpy.mockRestore();
    });

    it("keeps unmatched tracks as null when fallback batch search fails", async () => {
        const searchBatchSpy = jest
            .spyOn(ytMusicService, "searchBatch")
            .mockResolvedValueOnce([
                {
                    results: [
                        {
                            videoId: "first",
                            title: "Track One",
                            artist: "Artist One",
                            type: "song",
                            duration_seconds: 190,
                        },
                    ],
                    total: 1,
                    error: null,
                },
                {
                    results: [],
                    total: 0,
                    error: null,
                },
            ])
            .mockRejectedValueOnce(new Error("fallback failed"));

        const tracks = [
            { artist: "Artist One", title: "Track One" },
            { artist: "Artist Two", title: "Track Two" },
        ];

        const result = await ytMusicService.findMatchesForAlbum("u1", tracks);
        expect(result).toEqual([
            { videoId: "first", title: "Track One", duration: 190 },
            null,
        ]);
        expect(searchBatchSpy).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith(
            "[YTMusic] Batch fallback search failed:",
            expect.any(Error),
        );
    });

    it("rejects ambiguous best candidates when top score confidence spread is too small", () => {
        const scoreSpy = jest
            .spyOn(ytMusicService as any, "scoreCandidate")
            .mockReturnValueOnce(0.63)
            .mockReturnValueOnce(0.6);

        const winner = (ytMusicService as any).selectBestCandidate(
            {
                artist: "Artist",
                title: "Ambiguous Title",
            },
            [
                {
                    videoId: "first",
                    title: "Ambiguous Title",
                    artist: "Artist",
                },
                {
                    videoId: "second",
                    title: "Ambiguous Title",
                    artist: "Artist",
                },
            ],
        );

        expect(winner).toBeNull();
        expect(scoreSpy).toHaveBeenCalledTimes(2);
    });

    it("logs a warning when third-track matching attempt fails and returns null", async () => {
        const searchSpy = jest.spyOn(ytMusicService, "search");
        searchSpy
            .mockResolvedValueOnce({ results: [], total: 0 })
            .mockResolvedValueOnce({ results: [], total: 0 })
            .mockRejectedValueOnce(new Error("all failed"));

        await expect(
            ytMusicService.findMatchForTrack("u1", "Artist", "Song", "Album"),
        ).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            '[YTMusic] All search attempts failed for "Artist - Song":',
            expect.any(Error),
        );
    });

    it("propagates cancellation into track matching and stops fallback searches", async () => {
        const controller = new AbortController();
        const searchSpy = jest
            .spyOn(ytMusicService, "search")
            .mockImplementationOnce(async (...args) => {
                expect(args[4]).toEqual(
                    expect.objectContaining({
                        signal: controller.signal,
                        maxRetries: 0,
                    }),
                );
                controller.abort();
                const error = new Error("cancelled");
                error.name = "AbortError";
                throw error;
            });

        await expect(
            ytMusicService.findMatchForTrack(
                "u1",
                "Artist",
                "Song",
                "Album",
                undefined,
                undefined,
                { signal: controller.signal, maxRetries: 0 },
            ),
        ).rejects.toThrow("cancelled");
        expect(searchSpy).toHaveBeenCalledTimes(1);
    });

    it("loads a bounded public radio queue for a seed video", async () => {
        mockClient.get.mockResolvedValueOnce({
            data: {
                playlistId: "RDseed",
                seedVideoId: "seed-1",
                tracks: [{ videoId: "related-1", title: "Related" }],
            },
        });

        await expect(ytMusicService.getRadio("seed-1", 24)).resolves.toEqual({
            playlistId: "RDseed",
            seedVideoId: "seed-1",
            tracks: [{ videoId: "related-1", title: "Related" }],
        });
        expect(mockClient.get).toHaveBeenLastCalledWith("/radio", {
            params: { video_id: "seed-1", limit: 24 },
            timeout: 13_000,
        });
    });

    it("coalesces and briefly caches identical public radio requests", async () => {
        const radio = {
            playlistId: "RDseed",
            seedVideoId: "seed-cache",
            tracks: [{ videoId: "related-1", title: "Related" }],
        };
        mockClient.get.mockResolvedValue({ data: radio });

        await expect(
            Promise.all([
                ytMusicService.getRadio("seed-cache", 20),
                ytMusicService.getRadio("seed-cache", 20),
                ytMusicService.getRadio("seed-cache", 20),
            ]),
        ).resolves.toEqual([radio, radio, radio]);
        await expect(
            ytMusicService.getRadio("seed-cache", 20),
        ).resolves.toEqual(radio);

        expect(mockClient.get).toHaveBeenCalledTimes(1);

        await ytMusicService.getRadio("seed-cache", 21);
        expect(mockClient.get).toHaveBeenCalledTimes(2);
    });

    it("does not cache rejected public radio fills", async () => {
        mockClient.get
            .mockRejectedValueOnce(new Error("radio unavailable"))
            .mockResolvedValueOnce({
                data: {
                    playlistId: "RDrecovered",
                    seedVideoId: "seed-retry",
                    tracks: [],
                },
            });

        await expect(ytMusicService.getRadio("seed-retry", 20)).rejects.toThrow(
            "radio unavailable",
        );
        await expect(
            ytMusicService.getRadio("seed-retry", 20),
        ).resolves.toEqual(
            expect.objectContaining({ playlistId: "RDrecovered" }),
        );
        expect(mockClient.get).toHaveBeenCalledTimes(2);
    });
});
