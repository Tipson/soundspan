import { jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";

type RateLimitOptions = {
    windowMs: number;
    max: number;
    message: string;
    standardHeaders: boolean;
    legacyHeaders: boolean;
    validate: { trustProxy: boolean };
    store?: unknown;
    skipSuccessfulRequests?: boolean;
    skip?: (req: {
        path: string;
        headers?: Record<string, string | undefined>;
        query?: Record<string, unknown>;
    }) => boolean;
    keyGenerator?: (req: {
        ip: string;
        user?: { id: string };
        federationPeer?: { id: string };
    }) => string;
    handler?: (
        req: { ip: string; method: string; path: string },
        res: {
            status: (code: number) => {
                send: (message: string) => unknown;
                json: (body: unknown) => unknown;
            };
        },
        next: jest.Mock,
        options: { statusCode: number; message: string },
    ) => void;
};

type RateLimitHandlerResponse = {
    status: jest.MockedFunction<(code: number) => RateLimitHandlerResponse>;
    send: jest.MockedFunction<(message: string) => void>;
    json: jest.MockedFunction<(body: unknown) => void>;
};

const mockRateLimit = jest.fn((options: RateLimitOptions) => options);
const mockRateLimiterLoggerWarn = jest.fn();
const mockCreateRedisRateLimitOptions = jest.fn(
    (name: string, options?: { fallback?: "memory" | "open" }) => ({
        store: `redis:${name}`,
        passOnStoreError: true,
        fallback: options?.fallback,
    }),
);

jest.mock("../../utils/logger", () => ({
    logger: {
        warn: (...args: unknown[]) => mockRateLimiterLoggerWarn(...args),
    },
}));

describe("rateLimiter middleware config", () => {
    async function loadRateLimiterModule() {
        jest.resetModules();
        mockRateLimit.mockClear();
        mockRateLimiterLoggerWarn.mockClear();
        mockCreateRedisRateLimitOptions.mockClear();

        jest.doMock("express-rate-limit", () => ({
            __esModule: true,
            default: (options: RateLimitOptions) => mockRateLimit(options),
            ipKeyGenerator: (ip: string) => ip,
        }));
        jest.doMock("../rateLimitStore", () => ({
            createRedisRateLimitOptions: mockCreateRedisRateLimitOptions,
        }));

        return import("../rateLimiter");
    }

    function getOptions(module: object, exportName: string): RateLimitOptions {
        return (module as Record<string, unknown>)[
            exportName
        ] as RateLimitOptions;
    }

    it("creates each limiter with the documented window and max values", async () => {
        const mod = await loadRateLimiterModule();

        expect(mockRateLimit).toHaveBeenCalledTimes(20);
        expect(mod.apiLimiter).toBeDefined();
        expect(mod.internalCanonicalIdentityLimiter).toBeDefined();
        expect(mod.adminSurfaceLimiter).toBeDefined();
        expect(mod.shareLinkLimiter).toBeDefined();
        expect(mod.playbackStateLimiter).toBeDefined();
        expect(mod.authLimiter).toBeDefined();
        expect(mod.refreshLimiter).toBeDefined();
        expect(mod.oidcFlowLimiter).toBeDefined();
        expect(mod.libraryMetadataLimiter).toBeDefined();
        expect(mod.imageLimiter).toBeDefined();
        expect(mod.coverArtLimiter).toBeDefined();
        expect(mod.streamingLimiter).toBeDefined();
        expect(mod.downloadLimiter).toBeDefined();
        expect(mod.lyricsLimiter).toBeDefined();
        expect(mod.lyricsMutationLimiter).toBeDefined();
        expect(mod.musicBrainzArtistSearchLimiter).toBeDefined();
        expect(mod.ytMusicSearchLimiter).toBeDefined();
        expect(mod.ytMusicStreamLimiter).toBeDefined();
        expect(mod.webhookLimiter).toBeDefined();
        expect(mod.federationPeerLimiter).toBeDefined();

        const expectedConfigs = [
            { exportName: "apiLimiter", windowMs: 60_000, max: 5000 },
            {
                exportName: "internalCanonicalIdentityLimiter",
                windowMs: 60_000,
                max: 300,
            },
            {
                exportName: "adminSurfaceLimiter",
                windowMs: 60_000,
                max: 5000,
            },
            {
                exportName: "shareLinkLimiter",
                windowMs: 60_000,
                max: 5000,
            },
            {
                exportName: "playbackStateLimiter",
                windowMs: 60_000,
                max: 600,
            },
            { exportName: "authLimiter", windowMs: 900_000, max: 40 },
            { exportName: "refreshLimiter", windowMs: 300_000, max: 60 },
            { exportName: "oidcFlowLimiter", windowMs: 900_000, max: 40 },
            {
                exportName: "libraryMetadataLimiter",
                windowMs: 60_000,
                max: 5000,
            },
            { exportName: "imageLimiter", windowMs: 60_000, max: 500 },
            {
                exportName: "coverArtLimiter",
                windowMs: 60_000,
                max: 5000,
            },
            {
                exportName: "streamingLimiter",
                windowMs: 60_000,
                max: 10_000,
            },
            { exportName: "downloadLimiter", windowMs: 60_000, max: 100 },
            { exportName: "lyricsLimiter", windowMs: 60_000, max: 120 },
            {
                exportName: "lyricsMutationLimiter",
                windowMs: 900_000,
                max: 20,
            },
            {
                exportName: "musicBrainzArtistSearchLimiter",
                windowMs: 60_000,
                max: 20,
            },
            { exportName: "ytMusicSearchLimiter", windowMs: 60_000, max: 30 },
            {
                exportName: "ytMusicStreamLimiter",
                windowMs: 60_000,
                max: 120,
            },
            { exportName: "webhookLimiter", windowMs: 60_000, max: 60 },
            {
                exportName: "federationPeerLimiter",
                windowMs: 60_000,
                max: 1000,
            },
        ];

        for (const config of expectedConfigs) {
            expect(getOptions(mod, config.exportName)).toEqual(
                expect.objectContaining({
                    windowMs: config.windowMs,
                    max: config.max,
                }),
            );
        }

        expect(getOptions(mod, "authLimiter").skipSuccessfulRequests).toBe(
            true,
        );
        expect(getOptions(mod, "refreshLimiter").skipSuccessfulRequests).toBe(
            true,
        );
        expect(
            getOptions(mod, "oidcFlowLimiter").skipSuccessfulRequests,
        ).not.toBe(true);
    });

    it.each([
        ["canonical-identity-promotion", "internalCanonicalIdentityLimiter"],
        ["admin-surface", "adminSurfaceLimiter"],
        ["share-link", "shareLinkLimiter"],
        ["auth", "authLimiter"],
        ["auth-refresh", "refreshLimiter"],
        ["oidc-flow", "oidcFlowLimiter"],
        ["cover-art-surface", "coverArtLimiter"],
        ["streaming-surface", "streamingLimiter"],
        ["musicbrainz-artist-search", "musicBrainzArtistSearchLimiter"],
        ["webhook", "webhookLimiter"],
        ["federation-peer", "federationPeerLimiter"],
    ])("uses the namespaced shared store for %s", async (name, exportName) => {
        const mod = await loadRateLimiterModule();

        expect(getOptions(mod, exportName).store).toBe(`redis:${name}`);
    });

    it.each([
        "share-link",
        "canonical-identity-promotion",
        "auth",
        "auth-refresh",
        "oidc-flow",
        "cover-art-surface",
        "streaming-surface",
        "musicbrainz-artist-search",
        "webhook",
    ])("uses the memory fallback for the %s credential guard", async (name) => {
        await loadRateLimiterModule();

        expect(mockCreateRedisRateLimitOptions).toHaveBeenCalledWith(name, {
            fallback: "memory",
        });
    });

    it.each(["admin-surface", "federation-peer"])(
        "keeps the %s shared limiter availability-first",
        async (name) => {
            await loadRateLimiterModule();

            expect(mockCreateRedisRateLimitOptions).toHaveBeenCalledWith(name);
        },
    );

    it.each([
        ["general API", "apiLimiter"],
        ["playback state", "playbackStateLimiter"],
        ["library metadata", "libraryMetadataLimiter"],
        ["external image proxy", "imageLimiter"],
        ["download", "downloadLimiter"],
        ["lyrics lookup", "lyricsLimiter"],
        ["lyrics mutation", "lyricsMutationLimiter"],
        ["YouTube Music search", "ytMusicSearchLimiter"],
        ["YouTube Music stream", "ytMusicStreamLimiter"],
    ])("keeps the %s limiter in memory", async (_name, exportName) => {
        const mod = await loadRateLimiterModule();

        expect(getOptions(mod, exportName).store).toBeUndefined();
    });

    it("keys authenticated federation limits by peer identity", async () => {
        const mod = await loadRateLimiterModule();
        const keyGenerator = getOptions(
            mod,
            "federationPeerLimiter",
        ).keyGenerator!;

        expect(
            keyGenerator({ ip: "10.0.0.1", federationPeer: { id: "peer-1" } }),
        ).toBe("peer-1");
        expect(keyGenerator({ ip: "10.0.0.1" })).toBe("unresolved-peer");
    });

    it("keys MusicBrainz artist search limits by authenticated account", async () => {
        const mod = await loadRateLimiterModule();
        const keyGenerator = getOptions(
            mod,
            "musicBrainzArtistSearchLimiter",
        ).keyGenerator!;

        expect(
            keyGenerator({ ip: "10.0.0.1", user: { id: "account-1" } }),
        ).toBe("account-1");
        expect(keyGenerator({ ip: "10.0.0.1" })).toBe("unresolved-account");
    });

    it("counts only uncached YouTube Music stream starts per account", async () => {
        const mod = await loadRateLimiterModule();
        const options = getOptions(mod, "ytMusicStreamLimiter");
        const skip = options.skip!;
        const keyGenerator = options.keyGenerator!;

        expect(
            skip({
                path: "/api/ytmusic/stream-public/video-1",
                headers: { range: "bytes=524288-1048575" },
                query: {},
            }),
        ).toBe(true);
        expect(
            skip({
                path: "/api/ytmusic/stream-public/video-1",
                headers: { range: "bytes=0-524287" },
                query: {},
            }),
        ).toBe(false);
        expect(
            skip({
                path: "/api/ytmusic/stream-info/video-1",
                headers: {},
                query: { cachedOnly: "true" },
            }),
        ).toBe(true);
        expect(
            skip({
                path: "/api/ytmusic/stream-info/video-1",
                headers: {},
                query: {},
            }),
        ).toBe(false);
        expect(
            keyGenerator({ ip: "10.0.0.1", user: { id: "account-1" } }),
        ).toBe("account-1");
        expect(keyGenerator({ ip: "10.0.0.1" })).toBe("10.0.0.1");
    });

    it("uses standard headers, disables legacy headers, and disables trustProxy validation for all limiters", async () => {
        await loadRateLimiterModule();

        for (const [options] of mockRateLimit.mock.calls) {
            expect(options).toEqual(
                expect.objectContaining({
                    standardHeaders: true,
                    legacyHeaders: false,
                    validate: { trustProxy: false },
                }),
            );
        }
    });

    it("apiLimiter skip function bypasses only intended health, streaming, and polling endpoints", async () => {
        const mod = await loadRateLimiterModule();
        const skip = getOptions(mod, "apiLimiter").skip as (req: {
            path: string;
        }) => boolean;

        expect(skip({ path: "/health" })).toBe(true);
        expect(skip({ path: "/api/health" })).toBe(true);
        expect(
            skip({ path: "/api/podcasts/podcast-1/episodes/episode-2/stream" }),
        ).toBe(true);
        expect(
            skip({
                path: "/api/soulseek/search/abc123de-adbe-4cab-9fed-1234567890ab",
            }),
        ).toBe(true);
        expect(skip({ path: "/api/spotify/import/job_123/status" })).toBe(
            false,
        );

        expect(skip({ path: "/health/check" })).toBe(false);
        expect(
            skip({
                path: "/api/podcasts/podcast-1/episodes/episode-2/download",
            }),
        ).toBe(false);
        expect(skip({ path: "/api/soulseek/search/ABC-123" })).toBe(false);
        expect(skip({ path: "/api/spotify/import/job_123/status/extra" })).toBe(
            false,
        );
        expect(skip({ path: "/api/other" })).toBe(false);
    });

    it("apiLimiter handler logs the offending request and sends the configured limit response", async () => {
        const mod = await loadRateLimiterModule();
        const handler = getOptions(mod, "apiLimiter").handler as NonNullable<
            RateLimitOptions["handler"]
        >;
        const res = {} as RateLimitHandlerResponse;
        res.status = jest.fn((_: number) => res);
        res.send = jest.fn();
        res.json = jest.fn();

        handler(
            { ip: "10.0.0.1", method: "GET", path: "/api/library" },
            res,
            jest.fn(),
            {
                statusCode: 429,
                message:
                    "Too many requests from this IP, please try again later.",
            },
        );

        expect(mockRateLimiterLoggerWarn).toHaveBeenCalledWith(
            "API rate limit exceeded: 10.0.0.1 on GET /api/library",
        );
        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.send).toHaveBeenCalledWith(
            "Too many requests from this IP, please try again later.",
        );
    });

    it("authLimiter handler logs the client IP and sends the configured limit response", async () => {
        const mod = await loadRateLimiterModule();
        const handler = getOptions(mod, "authLimiter").handler as NonNullable<
            RateLimitOptions["handler"]
        >;
        const res = {} as RateLimitHandlerResponse;
        res.status = jest.fn((_: number) => res);
        res.send = jest.fn();
        res.json = jest.fn();

        handler(
            { ip: "10.0.0.2", method: "POST", path: "/api/auth/login" },
            res,
            jest.fn(),
            {
                statusCode: 429,
                message:
                    "Too many login attempts, please try again in 15 minutes.",
            },
        );

        expect(mockRateLimiterLoggerWarn).toHaveBeenCalledWith(
            "Auth rate limit exceeded: 10.0.0.2",
        );
        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.send).toHaveBeenCalledWith(
            "Too many login attempts, please try again in 15 minutes.",
        );
    });

    it("refreshLimiter returns the stable JSON rate-limit response", async () => {
        const mod = await loadRateLimiterModule();
        const handler = getOptions(mod, "refreshLimiter")
            .handler as NonNullable<RateLimitOptions["handler"]>;
        const res = {} as RateLimitHandlerResponse;
        res.status = jest.fn((_: number) => res);
        res.send = jest.fn();
        res.json = jest.fn();

        handler(
            { ip: "10.0.0.3", method: "POST", path: "/api/auth/refresh" },
            res,
            jest.fn(),
            {
                statusCode: 429,
                message:
                    "Too many token refresh attempts. Please try again later.",
            },
        );

        expect(mockRateLimiterLoggerWarn).toHaveBeenCalledWith(
            "Refresh rate limit exceeded: 10.0.0.3",
        );
        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.json).toHaveBeenCalledWith({
            error: "Too many token refresh attempts. Please try again later.",
            code: "RATE_LIMITED",
        });
    });

    it("counts redirect responses against the OIDC flow limit", async () => {
        jest.resetModules();
        jest.dontMock("express-rate-limit");
        jest.doMock("../rateLimitStore", () => {
            const { MemoryStore } = jest.requireActual(
                "express-rate-limit",
            ) as {
                MemoryStore: new () => unknown;
            };
            return {
                createRedisRateLimitOptions: () => ({
                    store: new MemoryStore(),
                    passOnStoreError: true,
                }),
            };
        });
        const { oidcFlowLimiter } = await import("../rateLimiter");
        const runRedirect = async (): Promise<number> => {
            const req = {
                app: { get: () => false },
                headers: {},
                ip: "127.0.0.1",
                originalUrl: "/oidc",
                socket: { remoteAddress: "127.0.0.1" },
            } as unknown as Request & {
                rateLimit?: { remaining: number };
            };
            const res = {
                headersSent: false,
                statusCode: 302,
                setHeader: jest.fn(),
            } as unknown as Response;
            await new Promise<void>((resolve, reject) => {
                const next: NextFunction = (error?: unknown) => {
                    if (error) reject(error);
                    else resolve();
                };
                oidcFlowLimiter(req, res, next);
            });
            return req.rateLimit!.remaining;
        };

        const firstRemaining = await runRedirect();
        const secondRemaining = await runRedirect();

        expect(secondRemaining).toBe(firstRemaining - 1);
    });
});
