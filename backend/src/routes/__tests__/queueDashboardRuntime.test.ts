import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import type { ApiKey, User } from "@prisma/client";
import type { DashboardBinding } from "../../utils/dashboardSessions";

const mockConfig = { secureCookies: true };
jest.mock("../../config", () => ({ config: mockConfig }));
jest.mock("../../utils/db", () => ({
    prisma: {
        user: { findUnique: jest.fn() },
        apiKey: { findUnique: jest.fn(), update: jest.fn() },
    },
}));
jest.mock("../../utils/logger", () => ({
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
jest.mock("../adminLibraryHealthPurge", () => ({
    handlePurgeRemovedStatus: jest.fn(),
    handlePurgeRemovedTracksNow: jest.fn(),
}));
jest.mock("../../middleware/rateLimiter", () => ({
    apiLimiter: (
        _req: express.Request,
        _res: express.Response,
        next: express.NextFunction,
    ) => next(),
}));
jest.mock("../auth/shared", () => ({
    sendLoginSuccess: jest.fn(),
    verifyLoginSecondFactor: jest.fn(),
}));
const mockBindings = new Map<string, DashboardBinding>();
const mockAssociations = new Map<string, Set<string>>();
const mockDashboardSessions = {
    bootstrap: jest.fn(async (id: string, value: DashboardBinding) => {
        mockBindings.set(id, { ...value });
        const associated =
            mockAssociations.get(value.bearerHash) ?? new Set<string>();
        associated.add(id);
        mockAssociations.set(value.bearerHash, associated);
        return true;
    }),
    read: jest.fn(async (id: string) => mockBindings.get(id) ?? null),
    mint: jest.fn(
        async (
            id: string,
            expected: Pick<
                DashboardBinding,
                "ownerId" | "tokenVersion" | "epoch"
            >,
            nonce: string,
            hash: string,
        ) => {
            const current = mockBindings.get(id);
            if (
                !current ||
                current.ownerId !== expected.ownerId ||
                current.tokenVersion !== expected.tokenVersion ||
                current.epoch !== expected.epoch
            )
                return null;
            current.grantNonce ??= nonce;
            const associated = mockAssociations.get(hash) ?? new Set<string>();
            associated.add(id);
            mockAssociations.set(hash, associated);
            return current.grantNonce;
        },
    ),
    grantActive: jest.fn(
        async (
            id: string,
            expected: Pick<
                DashboardBinding,
                "ownerId" | "tokenVersion" | "epoch"
            >,
            nonce: string,
        ) => {
            const current = mockBindings.get(id);
            return (
                current?.ownerId === expected.ownerId &&
                current.tokenVersion === expected.tokenVersion &&
                current.epoch === expected.epoch &&
                current.grantNonce === nonce
            );
        },
    ),
    revoke: jest.fn(
        async (id: string | null, hash: string | null, all = true) => {
            const originalHash = id
                ? mockBindings.get(id)?.bearerHash
                : undefined;
            if (all)
                for (const item of [hash, originalHash]) {
                    if (!item) continue;
                    for (const target of mockAssociations.get(item) ?? [])
                        mockBindings.delete(target);
                    mockAssociations.delete(item);
                }
            if (id) mockBindings.delete(id);
        },
    ),
};
jest.mock("../../utils/dashboardSessionState", () => ({
    dashboardSessions: mockDashboardSessions,
}));

import { prisma } from "../../utils/db";

const TEST_SECRET = "queue-dashboard-transport-fixture-secret";
const admin: User = {
    id: "admin-1",
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
const userLookup = jest.mocked(prisma.user.findUnique);
let auth: typeof import("../../middleware/auth");
let adminRouter: typeof import("../admin").default;
let previousJwtSecret: string | undefined;

function appWithAdminRoutes() {
    const app = express();
    app.use(express.json());
    app.use("/api/admin", adminRouter);
    app.use(
        "/api/admin/queues",
        auth.createQueueDashboardAccess(
            mockConfig.secureCookies,
            mockDashboardSessions,
        ),
        (_req, res) => {
            res.json({ dashboard: true });
        },
    );
    return app;
}

beforeAll(() => {
    previousJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
    auth = require("../../middleware/auth") as typeof auth;
    adminRouter = (require("../admin") as typeof import("../admin")).default;
});

afterAll(() => {
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockBindings.clear();
    mockAssociations.clear();
    mockConfig.secureCookies = true;
    // Persistence is the controlled boundary; Express and JWT validation run for real.
    userLookup.mockResolvedValue(admin);
});

test("an interactive administrator mints a narrow short-lived dashboard cookie", async () => {
    const binding = await bootstrapCookie();
    const response = await request(appWithAdminRoutes())
        .post("/api/admin/queues/session")
        .set("Authorization", `Bearer ${auth.generateToken(admin)}`)
        .set("Cookie", binding)
        .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ expiresIn: 900 });
    const cookies: unknown = response.headers["set-cookie"];
    expect(Array.isArray(cookies)).toBe(true);
    if (!Array.isArray(cookies) || typeof cookies[0] !== "string") {
        throw new Error("Expected a dashboard Set-Cookie header");
    }
    const cookie = cookies[0];
    expect(cookie).toMatch(/^__Secure-soundspan-queues=/);
    expect(cookie).toContain("Path=/api/admin/queues");
    expect(cookie).toContain("Max-Age=900");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Domain=");
    const token = cookie.split(";", 1)[0].split("=").slice(1).join("=");
    const claims = jwt.verify(token, TEST_SECRET, {
        algorithms: ["HS256"],
        audience: "soundspan-queue-dashboard",
    });
    expect(claims).toEqual(
        expect.objectContaining({
            userId: admin.id,
            tokenVersion: admin.tokenVersion,
            type: "queue-dashboard",
        }),
    );
    expect(response.body).not.toHaveProperty("token");
});

async function mintCookie(): Promise<string> {
    const binding = await bootstrapCookie();
    const response = await request(appWithAdminRoutes())
        .post("/api/admin/queues/session")
        .set("Authorization", `Bearer ${auth.generateToken(admin)}`)
        .set("Cookie", binding)
        .send({});
    expect(response.status).toBe(200);
    const cookies: unknown = response.headers["set-cookie"];
    if (!Array.isArray(cookies) || typeof cookies[0] !== "string") {
        throw new Error("Expected a dashboard Set-Cookie header");
    }
    return `${binding}; ${cookies[0].split(";", 1)[0]}`;
}

async function bootstrapCookie(): Promise<string> {
    const response = await request(appWithAdminRoutes())
        .post("/api/admin/queues/binding")
        .set("Authorization", `Bearer ${auth.generateToken(admin)}`)
        .send({});
    expect(response.status).toBe(204);
    const cookies: unknown = response.headers["set-cookie"];
    if (!Array.isArray(cookies) || typeof cookies[0] !== "string")
        throw new Error("Expected binding cookie");
    return cookies[0].split(";", 1)[0];
}

function grantToken(cookieHeader: string): string {
    const pair = cookieHeader
        .split(";")
        .map((item) => item.trim())
        .find(
            (item) =>
                item.startsWith("__Secure-soundspan-queues=") ||
                item.startsWith("soundspan-queues="),
        );
    if (!pair) throw new Error("Expected dashboard grant cookie");
    return pair.slice(pair.indexOf("=") + 1);
}

test("the browser can load the dashboard with only its dashboard cookie", async () => {
    const response = await request(appWithAdminRoutes())
        .get("/api/admin/queues")
        .set("Cookie", await mintCookie());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ dashboard: true });
});

test("an existing binding is not re-sent by a delayed-safe bootstrap", async () => {
    const binding = await bootstrapCookie();
    const response = await request(appWithAdminRoutes())
        .post("/api/admin/queues/binding")
        .set("Authorization", `Bearer ${auth.generateToken(admin)}`)
        .set("Cookie", binding)
        .send({});
    expect(response.status).toBe(204);
    expect(response.headers["set-cookie"]).toBeUndefined();
});

test("mint cannot recreate absent browser state", async () => {
    const binding = await bootstrapCookie();
    mockBindings.clear();
    const response = await request(appWithAdminRoutes())
        .post("/api/admin/queues/session")
        .set("Authorization", `Bearer ${auth.generateToken(admin)}`)
        .set("Cookie", binding)
        .send({});
    expect(response.status).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(mockBindings.size).toBe(0);
});

test("a mint without any prepared binding is refused", async () => {
    expect(
        (
            await request(appWithAdminRoutes())
                .post("/api/admin/queues/session")
                .set("Authorization", `Bearer ${auth.generateToken(admin)}`)
                .send({})
        ).status,
    ).toBe(401);
});

test.each(["anonymous", "user", "api-key"])(
    "binding preparation rejects %s transport",
    async (kind) => {
        const call = request(appWithAdminRoutes()).post(
            "/api/admin/queues/binding",
        );
        if (kind === "user") {
            const user = { ...admin, role: "user" };
            userLookup.mockResolvedValue(user);
            call.set("Authorization", `Bearer ${auth.generateToken(user)}`);
        }
        if (kind === "api-key") call.set("X-API-Key", "fixture-key");
        const response = await call.send({});
        expect(response.status).toBe(kind === "anonymous" ? 401 : 403);
        expect(response.headers["set-cookie"]).toBeUndefined();
    },
);

test("a different administrator receives a new binding instead of inheriting the former owner", async () => {
    const cookie = await mintCookie();
    const nextAdmin = { ...admin, id: "admin-2", username: "admin-2" };
    userLookup.mockResolvedValue(nextAdmin);
    const response = await request(appWithAdminRoutes())
        .post("/api/admin/queues/binding")
        .set("Authorization", `Bearer ${auth.generateToken(nextAdmin)}`)
        .set("Cookie", cookie)
        .send({});
    expect(response.status).toBe(204);
    expect(
        Array.from(mockBindings.values()).map((record) => record.ownerId),
    ).toEqual([nextAdmin.id]);
    expect(
        (
            await request(appWithAdminRoutes())
                .get("/api/admin/queues")
                .set("Cookie", cookie)
        ).status,
    ).toBe(401);
});

test("bootstrap state failure does not emit a credential", async () => {
    const { DashboardStateUnavailableError } =
        require("../../utils/dashboardSessions") as typeof import("../../utils/dashboardSessions");
    mockDashboardSessions.bootstrap.mockRejectedValueOnce(
        new DashboardStateUnavailableError(),
    );
    const response = await request(appWithAdminRoutes())
        .post("/api/admin/queues/binding")
        .set("Authorization", `Bearer ${auth.generateToken(admin)}`)
        .send({});
    expect(response.status).toBe(503);
    expect(response.headers["set-cookie"]).toBeUndefined();
});

test("binding admission rejection does not issue either cookie", async () => {
    mockDashboardSessions.bootstrap.mockResolvedValueOnce(false);
    const response = await request(appWithAdminRoutes())
        .post("/api/admin/queues/binding")
        .set("Authorization", `Bearer ${auth.generateToken(admin)}`)
        .send({});
    expect(response.status).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
});

test("cookie state unavailability is reported as unavailable", async () => {
    const cookie = await mintCookie();
    const { DashboardStateUnavailableError } =
        require("../../utils/dashboardSessions") as typeof import("../../utils/dashboardSessions");
    mockDashboardSessions.grantActive.mockRejectedValueOnce(
        new DashboardStateUnavailableError(),
    );
    const response = await request(appWithAdminRoutes())
        .get("/api/admin/queues")
        .set("Cookie", cookie);
    expect(response.status).toBe(503);
});

test("failed revoke clears browser cookies but does not claim successful server logout", async () => {
    const cookie = await mintCookie();
    const app = appWithAdminRoutes();
    const local = express.Router();
    const register = (
        require("../auth/localCredentials") as typeof import("../auth/localCredentials")
    ).default;
    register(local);
    app.use("/api/auth", local);
    const { DashboardStateUnavailableError } =
        require("../../utils/dashboardSessions") as typeof import("../../utils/dashboardSessions");
    mockDashboardSessions.revoke.mockRejectedValueOnce(
        new DashboardStateUnavailableError(),
    );
    const response = await request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${auth.generateToken(admin)}`)
        .set("Cookie", cookie)
        .send({});
    expect(response.status).toBe(503);
    expect(response.headers["set-cookie"]).toHaveLength(2);
    for (const item of response.headers["set-cookie"])
        expect(item).toContain("Expires=Thu, 01 Jan 1970");
});

test("the real Bull Board adapter serves its HTML, asset, and queue API with the narrow cookie", async () => {
    const { createBullBoard } =
        require("@bull-board/api") as typeof import("@bull-board/api");
    const { ExpressAdapter } =
        require("@bull-board/express") as typeof import("@bull-board/express");
    const adapter = new ExpressAdapter();
    adapter.setBasePath("/api/admin/queues");
    createBullBoard({ queues: [], serverAdapter: adapter });
    const app = express();
    app.use("/api/admin", adminRouter);
    app.use(
        "/api/admin/queues",
        auth.createQueueDashboardAccess(true, mockDashboardSessions),
        adapter.getRouter(),
    );
    const cookie = await mintCookie();
    const html = await request(app)
        .get("/api/admin/queues")
        .set("Cookie", cookie);
    expect(html.status).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.headers["cache-control"]).toBe("no-store");
    const relativeAsset = /(?:src|href)="(static\/(?:css|js)\/[^\"]+)"/.exec(
        html.text,
    )?.[1];
    const base = /<base href="([^\"]+)"/.exec(html.text)?.[1];
    expect(relativeAsset).toBeDefined();
    expect(base).toBe("/api/admin/queues/");
    if (!relativeAsset || !base)
        throw new Error("Expected a Bull Board asset reference and base");
    const assetPath = new URL(
        relativeAsset,
        new URL(base, "http://dashboard.fixture"),
    ).pathname;
    const asset = await request(app).get(assetPath).set("Cookie", cookie);
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toMatch(/javascript|css/);
    const queues = await request(app)
        .get("/api/admin/queues/api/queues")
        .set("Cookie", cookie);
    expect(queues.status).toBe(200);
    expect(queues.body).toEqual(expect.objectContaining({ queues: [] }));
});

test("ending dashboard access clears the same narrow cookie", async () => {
    const response = await request(appWithAdminRoutes())
        .delete("/api/admin/queues/session")
        .set("Authorization", `Bearer ${auth.generateToken(admin)}`);
    expect(response.status).toBe(204);
    expect(response.headers["set-cookie"]).toEqual(
        expect.arrayContaining([
            expect.stringContaining(
                "__Secure-soundspan-queues=; Path=/api/admin/queues; Expires=Thu, 01 Jan 1970",
            ),
        ]),
    );
});

test("an API key cannot mint a browser dashboard session", async () => {
    const keyLookup = jest.mocked(prisma.apiKey.findUnique);
    const apiKey: ApiKey & { user: User } = {
        id: "fixture-key",
        key: "fixture-api-key",
        name: "fixture",
        userId: admin.id,
        lastUsed: new Date("2026-01-01T00:00:00Z"),
        createdAt: new Date(),
        user: admin,
    };
    keyLookup.mockResolvedValue(apiKey);
    jest.mocked(prisma.apiKey.update).mockResolvedValue(apiKey);
    const response = await request(appWithAdminRoutes())
        .post("/api/admin/queues/session")
        .set("X-API-Key", "fixture-api-key")
        .send({});
    expect(response.status).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
});

test("a normal user cannot mint dashboard access", async () => {
    const normalUser = { ...admin, id: "user-1", role: "user" };
    userLookup.mockResolvedValue(normalUser);
    const response = await request(appWithAdminRoutes())
        .post("/api/admin/queues/session")
        .set("Authorization", `Bearer ${auth.generateToken(normalUser)}`)
        .send({});
    expect(response.status).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
});

test("a password change during minting cannot upgrade an old access token", async () => {
    const binding = await bootstrapCookie();
    userLookup.mockResolvedValueOnce(admin);
    userLookup.mockResolvedValueOnce({ ...admin, tokenVersion: 3 });
    const response = await request(appWithAdminRoutes())
        .post("/api/admin/queues/session")
        .set("Authorization", `Bearer ${auth.generateToken(admin)}`)
        .set("Cookie", binding)
        .send({});
    expect(response.status).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
});

test("an access token expiring during minting is rejected as a credential failure", async () => {
    const binding = await bootstrapCookie();
    let now = Math.floor(Date.now() / 1000);
    const clock = jest.spyOn(Date, "now").mockImplementation(() => now * 1000);
    try {
        const token = jwt.sign(
            { userId: admin.id, tokenVersion: admin.tokenVersion },
            TEST_SECRET,
            { expiresIn: 1 },
        );
        const expiringUser = { ...admin };
        // Advance the controlled clock after the first signature verification,
        // when authentication consumes the persisted token version.
        Object.defineProperty(expiringUser, "tokenVersion", {
            get: () => {
                now += 2;
                return admin.tokenVersion;
            },
        });
        userLookup.mockResolvedValueOnce(expiringUser);
        const response = await request(appWithAdminRoutes())
            .post("/api/admin/queues/session")
            .set("Authorization", `Bearer ${token}`)
            .set("Cookie", binding)
            .send({});
        expect(response.status).toBe(401);
        expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {
        clock.mockRestore();
    }
});

test("an access token expiring during binding preparation is a credential failure", async () => {
    let now = Math.floor(Date.now() / 1000);
    const clock = jest.spyOn(Date, "now").mockImplementation(() => now * 1000);
    try {
        const token = jwt.sign(
            { userId: admin.id, tokenVersion: admin.tokenVersion },
            TEST_SECRET,
            { expiresIn: 1 },
        );
        const expiringUser = { ...admin };
        Object.defineProperty(expiringUser, "tokenVersion", {
            get: () => {
                now += 2;
                return admin.tokenVersion;
            },
        });
        userLookup.mockResolvedValueOnce(expiringUser);
        const response = await request(appWithAdminRoutes())
            .post("/api/admin/queues/binding")
            .set("Authorization", `Bearer ${token}`)
            .send({});
        expect(response.status).toBe(401);
        expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {
        clock.mockRestore();
    }
});

test.each([
    ["demoted", { role: "user" }, 403],
    ["revoked", { tokenVersion: 3 }, 401],
    ["pending deletion", { pendingDeletionAt: new Date() }, 401],
] as const)(
    "a %s administrator cannot retain cookie dashboard access",
    async (_label, changes, status) => {
        const cookie = await mintCookie();
        userLookup.mockResolvedValue({ ...admin, ...changes });
        const response = await request(appWithAdminRoutes())
            .get("/api/admin/queues/api/queues")
            .set("Cookie", cookie);
        expect(response.status).toBe(status);
    },
);

test("a deleted administrator cannot retain cookie dashboard access", async () => {
    const cookie = await mintCookie();
    userLookup.mockResolvedValue(null);
    expect(
        (
            await request(appWithAdminRoutes())
                .get("/api/admin/queues")
                .set("Cookie", cookie)
        ).status,
    ).toBe(401);
});

test("a persistence outage reports unavailable without granting dashboard access", async () => {
    const cookie = await mintCookie();
    userLookup.mockRejectedValue(new Error("fixture database unavailable"));
    expect(
        (
            await request(appWithAdminRoutes())
                .get("/api/admin/queues")
                .set("Cookie", cookie)
        ).status,
    ).toBe(503);
});

test.each(["same-site", "cross-site", "none", undefined])(
    "cookie dashboard mutations reject Fetch Metadata %s",
    async (site) => {
        const call = request(appWithAdminRoutes())
            .post("/api/admin/queues/api/retry")
            .set("Cookie", await mintCookie());
        if (site !== undefined) call.set("Sec-Fetch-Site", site);
        expect((await call.send({})).status).toBe(403);
    },
);

test("same-origin dashboard XHR can mutate using its cookie", async () => {
    const response = await request(appWithAdminRoutes())
        .post("/api/admin/queues/api/retry")
        .set("Cookie", await mintCookie())
        .set("Sec-Fetch-Site", "same-origin")
        .send({});
    expect(response.status).toBe(200);
});

test("dashboard tokens do not become general API, refresh, or media tokens", async () => {
    const cookie = await mintCookie();
    const token = grantToken(cookie);
    const app = appWithAdminRoutes();
    const authRouter = express.Router();
    const register = (
        require("../auth/localCredentials") as typeof import("../auth/localCredentials")
    ).default;
    register(authRouter);
    app.use("/api/auth", authRouter);
    app.get("/api/private", auth.requireAuth, (_req, res) =>
        res.sendStatus(200),
    );
    app.get("/api/media", auth.requireAuthOrToken, (_req, res) =>
        res.sendStatus(200),
    );
    expect(
        (await request(app).get("/api/private").set("Cookie", cookie)).status,
    ).toBe(401);
    expect(
        (
            await request(app)
                .get("/api/private")
                .set("Authorization", `Bearer ${token}`)
        ).status,
    ).toBe(401);
    expect((await request(app).get("/api/media").query({ token })).status).toBe(
        401,
    );
    expect(() => auth.verifyAccessToken(token)).toThrow();
    expect(
        (
            await request(app)
                .post("/api/auth/refresh")
                .send({ refreshToken: token })
        ).status,
    ).toBe(401);
});

test("web logout also clears the browser's dashboard cookie", async () => {
    const app = appWithAdminRoutes();
    const authRouter = express.Router();
    const register = (
        require("../auth/localCredentials") as typeof import("../auth/localCredentials")
    ).default;
    register(authRouter);
    app.use("/api/auth", authRouter);
    const response = await request(app).post("/api/auth/logout").send({});
    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]).toEqual(
        expect.arrayContaining([
            expect.stringContaining(
                "__Secure-soundspan-queues=; Path=/api/admin/queues; Expires=Thu, 01 Jan 1970",
            ),
        ]),
    );
});

test("an identified logout fences a delayed dashboard mint", async () => {
    mockConfig.secureCookies = false;
    const app = appWithAdminRoutes();
    const authRouter = express.Router();
    const register = (
        require("../auth/localCredentials") as typeof import("../auth/localCredentials")
    ).default;
    register(authRouter);
    app.use("/api/auth", authRouter);
    const browser = request.agent(app);
    const bearer = auth.generateToken(admin);
    expect(
        (
            await browser
                .post("/api/admin/queues/binding")
                .set("Authorization", `Bearer ${bearer}`)
                .send({})
        ).status,
    ).toBe(204);
    let releaseLookup: (() => void) | undefined;
    let lookupEntered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
        lookupEntered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
        releaseLookup = resolve;
    });
    const delayedUser = { ...admin };
    // The persistence boundary is controllable without a fake JWT/HTTP stack.
    userLookup.mockResolvedValueOnce(admin);
    Object.defineProperty(delayedUser, "then", {
        value: (resolve: (value: User) => void) => {
            lookupEntered?.();
            void waiting.then(() => resolve(admin));
        },
    });
    userLookup.mockResolvedValueOnce(delayedUser);
    const mint = browser
        .post("/api/admin/queues/session")
        .set("Authorization", `Bearer ${bearer}`)
        .send({})
        .then((response) => response);
    let deadline: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            started,
            new Promise<void>((_resolve, reject) => {
                deadline = setTimeout(
                    () => reject(new Error("mint lookup did not start")),
                    2000,
                );
            }),
        ]);
        clearTimeout(deadline);
        const logout = await browser
            .post("/api/auth/logout")
            .set("Authorization", `Bearer ${bearer}`)
            .send({});
        expect(logout.status).toBe(200);
        releaseLookup?.();
        await mint;
        expect((await browser.get("/api/admin/queues")).status).toBe(401);
    } finally {
        clearTimeout(deadline);
        releaseLookup?.();
        await mint;
    }
}, 6000);

test.each([
    [
        "expired",
        {
            userId: admin.id,
            tokenVersion: 2,
            type: "queue-dashboard",
            aud: "soundspan-queue-dashboard",
            exp: 1,
        },
    ],
    [
        "wrong audience",
        {
            userId: admin.id,
            tokenVersion: 2,
            type: "queue-dashboard",
            aud: "other",
        },
    ],
    [
        "access type",
        { userId: admin.id, tokenVersion: 2, aud: "soundspan-queue-dashboard" },
    ],
    [
        "refresh type",
        {
            userId: admin.id,
            tokenVersion: 2,
            type: "refresh",
            aud: "soundspan-queue-dashboard",
        },
    ],
    [
        "malformed identity",
        { type: "queue-dashboard", aud: "soundspan-queue-dashboard" },
    ],
] as const)(
    "rejects a %s token in the dashboard cookie",
    async (_label, claims) => {
        const token = jwt.sign(claims, TEST_SECRET, { algorithm: "HS256" });
        const response = await request(appWithAdminRoutes())
            .get("/api/admin/queues")
            .set("Cookie", `__Secure-soundspan-queues=${token}`);
        expect(response.status).toBe(401);
    },
);

test("purpose-bound credentials cannot become ordinary access tokens", () => {
    const token = jwt.sign(
        { userId: admin.id, tokenVersion: 2, purpose: "dashboard" },
        TEST_SECRET,
    );
    expect(() => auth.verifyAccessToken(token)).toThrow();
});

test("a pending-deletion administrator cannot use bearer dashboard access", async () => {
    userLookup.mockResolvedValue({ ...admin, pendingDeletionAt: new Date() });
    expect(
        (
            await request(appWithAdminRoutes())
                .get("/api/admin/queues")
                .set("Authorization", `Bearer ${auth.generateToken(admin)}`)
        ).status,
    ).toBe(401);
});

test.each([false, true])(
    "cookie policy %s is independent of spoofed forwarding and trust-proxy settings",
    async (secure) => {
        mockConfig.secureCookies = secure;
        const binding = await bootstrapCookie();
        for (const trust of [false, 1]) {
            const app = appWithAdminRoutes();
            app.set("trust proxy", trust);
            for (const protocol of ["http", "https"]) {
                const response = await request(app)
                    .post("/api/admin/queues/session")
                    .set("Authorization", `Bearer ${auth.generateToken(admin)}`)
                    .set("Cookie", binding)
                    .set("X-Forwarded-Proto", protocol)
                    .send({});
                expect(response.status).toBe(200);
                const cookies: unknown = response.headers["set-cookie"];
                if (!Array.isArray(cookies) || typeof cookies[0] !== "string")
                    throw new Error("Expected cookie");
                expect(cookies[0].startsWith("__Secure-")).toBe(secure);
                expect(cookies[0].includes("; Secure;")).toBe(secure);
            }
        }
    },
);

test("a weaker cookie name and ambiguous or oversized headers are not accepted", async () => {
    const cookie = await mintCookie();
    const headers = [
        cookie.replace("__Secure-", ""),
        `${cookie}; ${cookie}`,
        `${cookie}; padding=${"x".repeat(4096)}`,
        `${cookie}; ${Array.from({ length: 64 }, (_, i) => `padding${i}=x`).join("; ")}`,
    ];
    for (const header of headers) {
        expect(
            (
                await request(appWithAdminRoutes())
                    .get("/api/admin/queues")
                    .set("Cookie", header)
            ).status,
        ).toBe(401);
    }
});

test("the dashboard fallthrough never grants other admin routes cookie authentication", async () => {
    const cookie = await mintCookie();
    for (const path of [
        "/api/admin/secrets-status",
        "/api/admin/queues-other",
        "/api/admin/library-health",
    ]) {
        expect(
            (
                await request(appWithAdminRoutes())
                    .get(path)
                    .set("Cookie", cookie)
            ).status,
        ).toBe(401);
    }
});
