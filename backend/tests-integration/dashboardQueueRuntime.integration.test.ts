import express from "express";
import request from "supertest";
import { createClient } from "redis";
import type { User } from "@prisma/client";

const redisUrl = process.env.INTEGRATION_REDIS_URL;
const suite =
    redisUrl && process.env.DASHBOARD_ISOLATED_REDIS === "1"
        ? describe
        : describe.skip;
const mockConfig = { secureCookies: false, localLoginEnabled: true };
const mockRedisClient = createClient({
    url: redisUrl,
    socket: { reconnectStrategy: false },
    disableOfflineQueue: true,
});
const control = createClient({
    url: redisUrl,
    socket: { reconnectStrategy: false },
    disableOfflineQueue: true,
});
jest.mock("../src/config", () => ({ config: mockConfig }));
jest.mock("../src/utils/redis", () => ({
    redisClient: {
        get isReady() {
            return mockRedisClient.isReady;
        },
        sendCommand: (
            args: string[],
            options: { timeout: number; abortSignal: AbortSignal },
        ) => mockRedisClient.sendCommand(args, options),
    },
}));
jest.mock("../src/utils/db", () => ({
    prisma: {
        user: { findUnique: jest.fn() },
        apiKey: { findUnique: jest.fn(), update: jest.fn() },
    },
}));
jest.mock("../src/utils/logger", () => ({
    logger: (() => {
        const log = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn(),
        };
        log.child.mockReturnValue(log);
        return log;
    })(),
}));
jest.mock("../src/routes/adminLibraryHealthPurge", () => ({
    handlePurgeRemovedStatus: jest.fn(),
    handlePurgeRemovedTracksNow: jest.fn(),
}));
jest.mock("../src/middleware/rateLimiter", () => ({
    apiLimiter: (
        _req: express.Request,
        _res: express.Response,
        next: express.NextFunction,
    ) => next(),
}));
jest.mock("otplib", () => ({ verify: jest.fn() }));

const admin: User = {
    id: "admin-redis-fixture",
    username: "admin",
    role: "admin",
    tokenVersion: 2,
    playHistoryEpoch: 0,
    playReceiptPrunedThrough: null,
    displayName: null,
    email: null,
    passwordHash: null,
    subsonicPassword: null,
    isTestAccount: true,
    onboardingComplete: true,
    enrichmentSettings: null,
    twoFactorEnabled: false,
    twoFactorSecret: null,
    twoFactorRecoveryCodes: null,
    profilePicture: null,
    moodMixParams: null,
    pendingDeletionAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
};

suite("dashboard HTTP ordering with real Redis grant state", () => {
    let auth: typeof import("../src/middleware/auth");
    let adminRouter: typeof import("../src/routes/admin").default;
    let registerLocal: typeof import("../src/routes/auth/localCredentials").default;
    let sendLoginSuccess: typeof import("../src/routes/auth/shared").sendLoginSuccess;
    let sessions: typeof import("../src/utils/dashboardSessionState").dashboardSessions;
    let userLookup: jest.MockedFunction<
        typeof import("../src/utils/db").prisma.user.findUnique
    >;

    beforeAll(async () => {
        if (!redisUrl || new URL(redisUrl).hostname !== "127.0.0.1")
            throw new Error("Explicit isolated loopback Redis required");
        await Promise.all([mockRedisClient.connect(), control.connect()]);
        auth = require("../src/middleware/auth") as typeof auth;
        adminRouter = (
            require("../src/routes/admin") as typeof import("../src/routes/admin")
        ).default;
        registerLocal = (
            require("../src/routes/auth/localCredentials") as typeof import("../src/routes/auth/localCredentials")
        ).default;
        sendLoginSuccess = (
            require("../src/routes/auth/shared") as typeof import("../src/routes/auth/shared")
        ).sendLoginSuccess;
        sessions = (
            require("../src/utils/dashboardSessionState") as typeof import("../src/utils/dashboardSessionState")
        ).dashboardSessions;
        const { prisma } =
            require("../src/utils/db") as typeof import("../src/utils/db");
        userLookup = jest.mocked(prisma.user.findUnique);
    });
    beforeEach(async () => {
        jest.clearAllMocks();
        await mockRedisClient.flushDb();
        userLookup.mockResolvedValue(admin);
    });
    afterAll(async () => {
        await mockRedisClient.flushDb();
        mockRedisClient.destroy();
        control.destroy();
    });

    function app() {
        const application = express();
        application.use(express.json());
        application.use("/api/admin", adminRouter);
        const local = express.Router();
        registerLocal(local);
        application.use("/api/auth", local);
        application.use(
            "/api/admin/queues",
            auth.createQueueDashboardAccess(false, sessions),
            (_req, res) => res.json({ dashboard: true }),
        );
        application.post("/api/fixture/accepted-sign-in", (_req, res) =>
            sendLoginSuccess(res, {
                ...admin,
                id: "account-b",
                username: "account-b",
                role: "user",
            }),
        );
        return application;
    }

    function delayedUser() {
        let entered: (() => void) | undefined;
        let release: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const value = { ...admin };
        Object.defineProperty(value, "then", {
            value: (resolve: (user: User) => void) => {
                entered?.();
                void pending.then(() => resolve(admin));
            },
        });
        return { value, started, release: () => release?.() };
    }

    async function bootstrap(
        browser: ReturnType<typeof request.agent>,
        token: string,
    ) {
        const response = await browser
            .post("/api/admin/queues/binding")
            .set("Authorization", `Bearer ${token}`)
            .send({});
        expect(response.status).toBe(204);
        return response;
    }

    test("identified logout before final mint prevents credential resurrection", async () => {
        const browser = request.agent(app());
        const token = auth.generateToken(admin);
        await bootstrap(browser, token);
        const delayed = delayedUser();
        userLookup
            .mockResolvedValueOnce(admin)
            .mockResolvedValueOnce(delayed.value);
        const mint = browser
            .post("/api/admin/queues/session")
            .set("Authorization", `Bearer ${token}`)
            .send({})
            .then((response) => response);
        try {
            await delayed.started;
            expect(
                (
                    await browser
                        .post("/api/auth/logout")
                        .set("Authorization", `Bearer ${token}`)
                        .send({})
                ).status,
            ).toBe(200);
            delayed.release();
            expect((await mint).status).toBe(401);
            expect((await browser.get("/api/admin/queues")).status).toBe(401);
        } finally {
            delayed.release();
            await mint;
        }
    }, 6000);

    test("an already committed cookie cannot be replayed after logout, even with its binding", async () => {
        const application = app();
        const browser = request.agent(application);
        const token = auth.generateToken(admin);
        const binding = await bootstrap(browser, token);
        const mint = await browser
            .post("/api/admin/queues/session")
            .set("Authorization", `Bearer ${token}`)
            .send({});
        expect(mint.status).toBe(200);
        const cookies = [
            binding.headers["set-cookie"][0],
            mint.headers["set-cookie"][0],
        ]
            .map((value: string) => value.split(";", 1)[0])
            .join("; ");
        expect((await browser.get("/api/admin/queues")).status).toBe(200);
        expect(
            (
                await browser
                    .post("/api/auth/logout")
                    .set("Authorization", `Bearer ${token}`)
                    .send({})
            ).status,
        ).toBe(200);
        expect(
            (
                await request(application)
                    .get("/api/admin/queues")
                    .set("Cookie", cookies)
            ).status,
        ).toBe(401);
    });

    test("successful account switch fences a pending mint without changing ordinary JWT format", async () => {
        const browser = request.agent(app());
        const token = auth.generateToken(admin);
        await bootstrap(browser, token);
        const delayed = delayedUser();
        userLookup
            .mockResolvedValueOnce(admin)
            .mockResolvedValueOnce(delayed.value);
        const mint = browser
            .post("/api/admin/queues/session")
            .set("Authorization", `Bearer ${token}`)
            .send({})
            .then((response) => response);
        try {
            await delayed.started;
            const login = await browser
                .post("/api/fixture/accepted-sign-in")
                .set("Authorization", `Bearer ${token}`)
                .send({});
            expect(login.status).toBe(200);
            expect(login.body.user.id).toBe("account-b");
            delayed.release();
            expect((await mint).status).toBe(401);
            expect((await browser.get("/api/admin/queues")).status).toBe(401);
        } finally {
            delayed.release();
            await mint;
        }
    }, 6000);

    test("identified account switch revokes bearer-associated grants even when a cookie is omitted", async () => {
        const application = app();
        const browser = request.agent(application);
        const token = auth.generateToken(admin);
        const binding = await bootstrap(browser, token);
        const mint = await browser
            .post("/api/admin/queues/session")
            .set("Authorization", `Bearer ${token}`)
            .send({});
        expect(mint.status).toBe(200);
        const pair = [
            binding.headers["set-cookie"][0],
            mint.headers["set-cookie"][0],
        ]
            .map((value: string) => value.split(";", 1)[0])
            .join("; ");
        const login = await request(application)
            .post("/api/fixture/accepted-sign-in")
            .set("Authorization", `Bearer ${token}`)
            .send({});
        expect(login.status).toBe(200);
        expect(
            (
                await request(application)
                    .get("/api/admin/queues")
                    .set("Cookie", pair)
            ).status,
        ).toBe(401);
    });

    test("a late first bootstrap after logout has no credential and cannot open the dashboard", async () => {
        const browser = request.agent(app());
        const token = auth.generateToken(admin);
        const delayed = delayedUser();
        userLookup.mockResolvedValueOnce(delayed.value);
        const binding = browser
            .post("/api/admin/queues/binding")
            .set("Authorization", `Bearer ${token}`)
            .send({})
            .then((response) => response);
        try {
            await delayed.started;
            expect(
                (
                    await browser
                        .post("/api/auth/logout")
                        .set("Authorization", `Bearer ${token}`)
                        .send({})
                ).status,
            ).toBe(200);
            delayed.release();
            expect((await binding).status).toBe(204);
            expect((await browser.get("/api/admin/queues")).status).toBe(401);
        } finally {
            delayed.release();
            await binding;
        }
    }, 6000);

    test("refresh retains the browser binding, and logout with the refreshed bearer removes the grant", async () => {
        const browser = request.agent(app());
        const token = auth.generateToken(admin);
        await bootstrap(browser, token);
        expect(
            (
                await browser
                    .post("/api/admin/queues/session")
                    .set("Authorization", `Bearer ${token}`)
                    .send({})
            ).status,
        ).toBe(200);
        const refresh = await browser
            .post("/api/auth/refresh")
            .send({ refreshToken: auth.generateRefreshToken(admin) });
        expect(refresh.status).toBe(200);
        expect(refresh.headers["set-cookie"]).toBeUndefined();
        expect((await browser.get("/api/admin/queues")).status).toBe(200);
        expect(
            (
                await browser
                    .post("/api/auth/logout")
                    .set("Authorization", `Bearer ${refresh.body.token}`)
                    .send({})
            ).status,
        ).toBe(200);
        expect((await browser.get("/api/admin/queues")).status).toBe(401);
    });

    test("parallel opens on two API apps preserve a late response cookie from the same binding", async () => {
        const application = app();
        const otherApplication = app();
        const browser = request.agent(application);
        const token = auth.generateToken(admin);
        const binding = await bootstrap(browser, token);
        const bindingCookie = binding.headers["set-cookie"][0].split(";", 1)[0];
        const [first, second] = await Promise.all([
            request(application)
                .post("/api/admin/queues/session")
                .set("Cookie", bindingCookie)
                .set("Authorization", `Bearer ${token}`)
                .send({}),
            request(otherApplication)
                .post("/api/admin/queues/session")
                .set("Cookie", bindingCookie)
                .set("Authorization", `Bearer ${token}`)
                .send({}),
        ]);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        const lateCookie = [
            binding.headers["set-cookie"][0],
            first.headers["set-cookie"][0],
        ]
            .map((value: string) => value.split(";", 1)[0])
            .join("; ");
        expect(
            (
                await request(application)
                    .get("/api/admin/queues")
                    .set("Cookie", lateCookie)
            ).status,
        ).toBe(200);
    });

    test("lost Redis state fails closed and explicit Open can establish a fresh binding", async () => {
        const browser = request.agent(app());
        const token = auth.generateToken(admin);
        await bootstrap(browser, token);
        expect(
            (
                await browser
                    .post("/api/admin/queues/session")
                    .set("Authorization", `Bearer ${token}`)
                    .send({})
            ).status,
        ).toBe(200);
        await mockRedisClient.flushDb();
        expect((await browser.get("/api/admin/queues")).status).toBe(401);
        expect(
            (
                await browser
                    .post("/api/admin/queues/session")
                    .set("Authorization", `Bearer ${token}`)
                    .send({})
            ).status,
        ).toBe(401);
        await bootstrap(browser, token);
        expect(
            (
                await browser
                    .post("/api/admin/queues/session")
                    .set("Authorization", `Bearer ${token}`)
                    .send({})
            ).status,
        ).toBe(200);
    });

    test("Redis command timeout refuses cookie access while a clean music sign-in stays available", async () => {
        const application = app();
        const browser = request.agent(application);
        const token = auth.generateToken(admin);
        await bootstrap(browser, token);
        expect(
            (
                await browser
                    .post("/api/admin/queues/session")
                    .set("Authorization", `Bearer ${token}`)
                    .send({})
            ).status,
        ).toBe(200);
        const pauseAt = Date.now();
        await control.sendCommand(["CLIENT", "PAUSE", "2200", "ALL"]);
        const getAt = Date.now();
        const denied = await browser.get("/api/admin/queues");
        console.log(
            JSON.stringify({
                fixture: "redis_command_deadline",
                pauseReplyMs: getAt - pauseAt,
                httpMs: Date.now() - getAt,
                status: denied.status,
            }),
        );
        expect(denied.status).toBe(503);
        const clean = await request(application)
            .post("/api/fixture/accepted-sign-in")
            .send({});
        expect(clean.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 800));
    }, 6000);
});
