import type { NextFunction, Request, Response } from "express";
const mockRecordFeedback = jest.fn();
jest.mock("../../services/playbackFeedback", () => ({
    recordPlaybackFeedback: mockRecordFeedback,
    playbackFeedbackSchema: require("zod").z.object({
        reason: require("zod").z.enum([
            "wrong_version",
            "no_sound",
            "interruption",
        ]),
        reportTrackId: require("zod").z.string().min(1),
    }),
}));

const mockPlaybackRouteLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
const mockPlaybackMetricLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
const mockPlaybackTraceLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
const mockRecordPlaybackClientMetric = jest.fn();
const mockDiagnosticWarn = jest.fn();
const mockDiagnosticAppend = jest.fn(
    async (_record: Record<string, unknown>) => {},
);
jest.mock("../../services/playbackDiagnosticJournal", () => ({
    playbackDiagnosticJournal: { append: mockDiagnosticAppend },
}));

jest.mock("../../metrics", () => ({
    recordPlaybackClientMetric: mockRecordPlaybackClientMetric,
}));

jest.mock("../../config", () => ({
    config: { streaming: { traceEnabled: true } },
}));

type AuthFailureMode = "ok" | "unauthorized";

const mockAuthFailureState = { mode: "ok" as AuthFailureMode };

const mockRequireAuth = jest.fn(
    (_req: Request, res: Response, next: NextFunction) => {
        if (mockAuthFailureState.mode === "unauthorized") {
            return res.status(401).json({ error: "Unauthorized" });
        }

        return next();
    },
);

jest.mock("../../middleware/auth", () => ({
    requireAuth: mockRequireAuth,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn((scope: string) => {
            if (scope === "Playback") return mockPlaybackRouteLogger;
            if (scope === "Playback.Metric") return mockPlaybackMetricLogger;
            if (scope === "Playback.Trace") return mockPlaybackTraceLogger;
            if (scope === "Playback.Diagnostic")
                return { warn: mockDiagnosticWarn };
            throw new Error(`Unexpected logger scope: ${scope}`);
        }),
    },
}));

import router from "../streaming";

function getClientMetricsRoute() {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === "/v1/client-metrics" &&
            entry.route?.methods?.post,
    );
    if (!layer) {
        throw new Error("Client metrics route not found");
    }
    return layer.route;
}

function getClientMetricsHandler() {
    const route = getClientMetricsRoute();
    return route.stack[route.stack.length - 1].handle;
}

function createResponse() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        setHeader: jest.fn(),
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };
    return res;
}

describe("playback client-signal route", () => {
    const postClientMetric = getClientMetricsHandler();

    beforeEach(() => {
        jest.clearAllMocks();
        mockAuthFailureState.mode = "ok";
        mockDiagnosticAppend.mockResolvedValue(undefined);
        mockRecordFeedback.mockResolvedValue(undefined);
    });
    it("acknowledges manual feedback only after admin persistence, including a retried journal receipt", async () => {
        const req = {
            user: { id: "report-user" },
            body: {
                event: "player.user_report",
                fields: {
                    reason: "no_sound",
                    reportTrackId: "yt:abc",
                    token: "secret",
                },
                diagnostic: {
                    id: "manual-report",
                    ownerId: "report-user",
                    observedAtMs: Date.now(),
                },
            },
        } as any;
        mockRecordFeedback.mockRejectedValueOnce(
            new Error("storage unavailable"),
        );
        const first = createResponse();
        await postClientMetric(req, first);
        expect(first.statusCode).toBe(503);
        const retry = createResponse();
        await postClientMetric(req, retry);
        expect(retry.statusCode).toBe(202);
        expect(mockRecordFeedback).toHaveBeenCalledTimes(2);
        expect(mockDiagnosticAppend).toHaveBeenCalledTimes(1);
        expect(mockRecordFeedback.mock.calls[1][3]).not.toHaveProperty("token");
    });
    it("rejects manual feedback without an owned durable envelope or valid reason", async () => {
        for (const body of [
            {
                event: "player.user_report",
                fields: { reason: "no_sound", reportTrackId: "yt:abc" },
            },
            {
                event: "player.user_report",
                fields: { reason: "anything" },
                diagnostic: {
                    id: "bad-report",
                    ownerId: "report-user",
                    observedAtMs: Date.now(),
                },
            },
        ]) {
            const res = createResponse();
            await postClientMetric({ user: { id: "report-user" }, body }, res);
            expect(res.statusCode).toBe(400);
        }
        expect(mockRecordFeedback).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated requests through the complete route chain", () => {
        mockAuthFailureState.mode = "unauthorized";
        const route = getClientMetricsRoute();
        const req = {
            method: "POST",
            url: "/v1/client-metrics",
            originalUrl: "/v1/client-metrics",
            baseUrl: "",
            body: { event: "player.engine_startup" },
        } as any;
        const res = createResponse();
        const next = jest.fn();

        expect(route.stack.map((layer: any) => layer.handle)).toContain(
            mockRequireAuth,
        );

        (router as any).handle(req, res, next);

        expect(mockRequireAuth).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Unauthorized" });
        expect(mockPlaybackMetricLogger.info).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
    });

    it("accepts native engine startup through the client-signal pipeline", async () => {
        const req = {
            user: { id: "user-1" },
            body: {
                event: "player.engine_startup",
                fields: {
                    engineMode: "native",
                    activeEngine: "native",
                    sourceType: "local",
                    trackId: "track-1",
                },
            },
        } as any;
        const res = createResponse();

        await postClientMetric(req, res);

        expect(res.statusCode).toBe(202);
        expect(res.body).toEqual({ accepted: true });
        expect(mockPlaybackMetricLogger.info).toHaveBeenCalledWith(
            "client.signal",
            expect.objectContaining({
                status: "success",
                event: "player.engine_startup",
                sourceType: "local",
                trackId: "track-1",
                userId: "user-1",
            }),
        );
        expect(mockPlaybackTraceLogger.info).toHaveBeenCalledWith(
            "playback.client.signal",
            expect.objectContaining({
                event: "player.engine_startup",
                userId: "user-1",
            }),
        );
        expect(mockRecordPlaybackClientMetric).toHaveBeenCalledWith({
            event: "player.engine_startup",
            sourceType: "local",
            outcome: undefined,
            reason: undefined,
            durationMs: undefined,
        });
    });

    it("records an incident through the real route without exposing arbitrary fields", async () => {
        const observedAtMs = Date.now();
        const req = {
            user: { id: "diagnostic-user" },
            body: {
                event: "player.unexpected_stop",
                fields: {
                    trackId: "yt:example",
                    playbackRunId: "anonymous-run",
                    currentTimeSec: 83,
                    token: "NEVER_LOG_ME",
                    url: "https://secret",
                },
                diagnostic: {
                    id: "route-event",
                    ownerId: "diagnostic-user",
                    observedAtMs,
                },
            },
        } as any;
        const res = createResponse();
        await postClientMetric(req, res);
        expect(res.statusCode).toBe(202);
        expect(mockDiagnosticWarn).toHaveBeenCalledTimes(1);
        expect(JSON.parse(mockDiagnosticWarn.mock.calls[0][0])).toEqual(
            expect.objectContaining({
                userId: "diagnostic-user",
                eventId: "route-event",
                observedAtMs,
                fields: { playbackRunId: "anonymous-run", currentTimeSec: 83 },
            }),
        );
        expect(
            JSON.stringify(mockPlaybackTraceLogger.info.mock.calls),
        ).not.toContain("NEVER_LOG_ME");
        expect(
            JSON.stringify(mockPlaybackTraceLogger.info.mock.calls),
        ).not.toContain("https://secret");
    });

    it("rejects a queued diagnostic after its authenticated owner changes", async () => {
        const req = {
            user: { id: "user-b" },
            body: {
                event: "player.unexpected_stop",
                diagnostic: {
                    id: "cross-user-event",
                    ownerId: "user-a",
                    observedAtMs: 100_000,
                },
            },
        } as any;
        const res = createResponse();
        await postClientMetric(req, res);
        expect(res.statusCode).toBe(400);
        expect(mockDiagnosticWarn).not.toHaveBeenCalled();
        expect(mockRecordPlaybackClientMetric).not.toHaveBeenCalled();
    });

    it("does not send 202 until the persistent diagnostic append resolves", async () => {
        let release!: () => void;
        mockDiagnosticAppend.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const res = createResponse();
        const request = postClientMetric(
            {
                user: { id: "durable-user" },
                body: {
                    event: "player.engine_pause",
                    diagnostic: {
                        id: "durable-event",
                        ownerId: "durable-user",
                        observedAtMs: Date.now(),
                    },
                },
            },
            res,
        );
        expect(res.json).not.toHaveBeenCalled();
        expect(mockDiagnosticAppend).toHaveBeenCalledTimes(1);
        release();
        await request;
        expect(res.statusCode).toBe(202);
    });

    it("returns a retryable 503 after storage failure without exposing IO details", async () => {
        mockDiagnosticAppend.mockRejectedValueOnce(
            new Error("/private/path SECRET"),
        );
        const req = {
            user: { id: "io-user" },
            body: {
                event: "player.unexpected_stop",
                diagnostic: {
                    id: "io-event",
                    ownerId: "io-user",
                    observedAtMs: Date.now(),
                },
            },
        };
        const res = createResponse();
        await postClientMetric(req, res);
        expect(res.statusCode).toBe(503);
        expect(JSON.stringify(res.body)).not.toMatch(/SECRET|private/);
        expect(mockDiagnosticWarn).not.toHaveBeenCalled();
        const retry = createResponse();
        await postClientMetric(req, retry);
        expect(retry.statusCode).toBe(202);
        expect(mockDiagnosticAppend).toHaveBeenCalledTimes(2);
    });

    it("returns 429 plus Retry-After rather than silently losing an offline burst", async () => {
        const body = {
            event: "player.unexpected_stop",
            diagnostic: {
                id: "",
                ownerId: "burst-user",
                observedAtMs: Date.now(),
            },
        };
        for (let i = 0; i < 60; i++) {
            const res = createResponse();
            await postClientMetric(
                {
                    user: { id: "burst-user" },
                    body: {
                        ...body,
                        diagnostic: { ...body.diagnostic, id: `burst-${i}` },
                    },
                },
                res,
            );
            expect(res.statusCode).toBe(202);
        }
        const res = createResponse();
        await postClientMetric(
            {
                user: { id: "burst-user" },
                body: {
                    ...body,
                    diagnostic: { ...body.diagnostic, id: "overflow" },
                },
            },
            res,
        );
        expect(res.statusCode).toBe(429);
        expect(res.setHeader).toHaveBeenCalledWith(
            "Retry-After",
            expect.any(String),
        );
        expect(mockDiagnosticAppend).toHaveBeenCalledTimes(60);
    });

    it.each(["expired", "future", "unknown-event", "oversize", "malformed"])(
        "rejects %s queued diagnostics without persisting or tracing raw fields",
        async (scenario) => {
            const now = Date.now();
            const body: any = {
                event: "player.unexpected_stop",
                fields: {},
                diagnostic: {
                    id: `invalid-${scenario}`,
                    ownerId: "schema-user",
                    observedAtMs: now,
                },
            };
            if (scenario === "expired")
                body.diagnostic.observedAtMs = now - 86_400_000 - 10_000;
            if (scenario === "future")
                body.diagnostic.observedAtMs = now + 120_000;
            if (scenario === "unknown-event") {
                body.event = "unknown.event";
                body.fields = { token: "NEVER_TRACE" };
            }
            if (scenario === "oversize")
                body.fields = { note: "界".repeat(3000) };
            if (scenario === "malformed") body.diagnostic.observedAtMs = 1.5;
            const res = createResponse();
            await postClientMetric({ user: { id: "schema-user" }, body }, res);
            expect(res.statusCode).toBe(scenario === "oversize" ? 413 : 400);
            expect(mockDiagnosticAppend).not.toHaveBeenCalled();
            expect(mockPlaybackTraceLogger.info).not.toHaveBeenCalled();
        },
    );

    it("does not copy request query strings into diagnostic traces", async () => {
        const res = createResponse();
        await postClientMetric(
            {
                user: { id: "query-user" },
                originalUrl: "/api/streaming/v1/client-metrics?token=SECRET",
                body: {
                    event: "player.visibility_change",
                    fields: { visibility: "hidden" },
                    diagnostic: {
                        id: "query-event",
                        ownerId: "query-user",
                        observedAtMs: Date.now(),
                    },
                },
            },
            res,
        );
        expect(res.statusCode).toBe(202);
        expect(
            JSON.stringify(mockPlaybackTraceLogger.info.mock.calls),
        ).not.toContain("SECRET");
    });

    it("keeps retired startup fields in the generic trace only", async () => {
        const fields = {
            outcome: "audible",
            loadId: 42,
            startupCorrelationId: "startup-42",
            totalToAudibleMs: 175,
        };
        const req = {
            user: { id: "user-1" },
            body: {
                event: "player.startup_timeline",
                fields,
            },
        } as any;
        const res = createResponse();

        await postClientMetric(req, res);

        expect(res.statusCode).toBe(202);
        const metricFields = mockPlaybackMetricLogger.info.mock.calls[0]?.[1];
        expect(metricFields).not.toHaveProperty("outcome");
        expect(metricFields).not.toHaveProperty("loadId");
        expect(metricFields).not.toHaveProperty("startupCorrelationId");
        expect(metricFields).not.toHaveProperty("totalToAudibleMs");
        expect(mockPlaybackTraceLogger.info).toHaveBeenCalledWith(
            "playback.client.signal",
            expect.objectContaining({ fields }),
        );
    });

    it("rejects unauthenticated client signals", async () => {
        const req = {
            body: { event: "player.engine_startup" },
        } as any;
        const res = createResponse();

        await postClientMetric(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Unauthorized" });
    });

    it("rejects malformed client signals", async () => {
        const req = {
            user: { id: "user-1" },
            body: { event: "" },
        } as any;
        const res = createResponse();

        await postClientMetric(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Invalid request body",
                details: expect.any(Object),
            }),
        );
    });

    it("returns 404 for the removed session surface", async () => {
        const req = {
            method: "POST",
            url: "/v1/sessions",
            originalUrl: "/v1/sessions",
            baseUrl: "",
        } as any;
        const res = { statusCode: 200 } as any;

        await new Promise<void>((resolve, reject) => {
            (router as any).handle(req, res, (error?: unknown) => {
                if (error) {
                    reject(error);
                    return;
                }
                res.statusCode = 404;
                resolve();
            });
        });

        expect(res.statusCode).toBe(404);
    });
});
