import express from "express";
import type { Server } from "node:http";
const mockSubmit = jest.fn();
const mockList = jest.fn();
const mockApprove = jest.fn();
jest.mock("../../services/testApplications", () => ({
    submitTestApplication: (...args: unknown[]) => mockSubmit(...args),
    listTestApplications: (...args: unknown[]) => mockList(...args),
    approveTestApplication: (...args: unknown[]) => mockApprove(...args),
    TestApplicationError: class extends Error {},
}));
jest.mock("../../middleware/auth", () => ({
    requireAuth: (
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
    ) => {
        if (!req.user)
            return res.status(401).json({ error: "Authentication required" });
        next();
    },
    requireAdmin: (
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
    ) => {
        if (req.user?.role !== "admin")
            return res.status(403).json({ error: "Admin required" });
        next();
    },
}));
jest.mock("../../middleware/rateLimitStore", () => ({
    createRedisRateLimitOptions: () => ({}),
}));
jest.mock("../../middleware/rateLimiter", () => ({
    adminSurfaceLimiter: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ error: jest.fn() }) },
}));
import registerTestApplicationRoutes from "../auth/testApplications";

let server: Server;
let origin: string;
beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        if (req.headers["x-test-role"])
            req.user = {
                id: "actor",
                username: "actor",
                role: String(req.headers["x-test-role"]),
            };
        next();
    });
    const router = express.Router();
    registerTestApplicationRoutes(router);
    app.use("/api/auth", router);
    server = await new Promise<Server>((resolve) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Missing test port");
    origin = `http://127.0.0.1:${address.port}/api/auth/test-applications`;
});
afterAll(async () => {
    if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
beforeEach(() => {
    jest.clearAllMocks();
    mockSubmit.mockResolvedValue(undefined);
    mockList.mockResolvedValue({ items: [], nextCursor: null });
    mockApprove.mockResolvedValue({
        status: "approved",
        registrationPath: "/register?code=PRIVATE",
    });
});

test("public receipt contains no approval status or invitation secret", async () => {
    const response = await fetch(origin, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegram: "listener_name" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(mockSubmit).toHaveBeenCalledTimes(1);
});
test.each([undefined, "user"])(
    "non-admin %s cannot list or approve contacts",
    async (role) => {
        const headers: Record<string, string> = role
            ? { "x-test-role": role }
            : {};
        expect((await fetch(origin, { headers })).status).toBe(
            role ? 403 : 401,
        );
        expect(
            (
                await fetch(`${origin}/application-1/approve`, {
                    method: "POST",
                    headers,
                })
            ).status,
        ).toBe(role ? 403 : 401);
        expect(mockList).not.toHaveBeenCalled();
        expect(mockApprove).not.toHaveBeenCalled();
    },
);
test("admin can read the list and approve with their authenticated identity", async () => {
    const headers = { "x-test-role": "admin" };
    expect((await fetch(origin, { headers })).status).toBe(200);
    const response = await fetch(`${origin}/application-1/approve`, {
        method: "POST",
        headers,
    });
    expect(response.status).toBe(200);
    expect(mockApprove).toHaveBeenCalledWith("application-1", "actor");
    expect(response.headers.get("cache-control")).toContain("no-store");
});
test("a persistence failure cannot be shown as an accepted application", async () => {
    mockSubmit.mockRejectedValueOnce(new Error("storage unavailable"));
    const response = await fetch(origin, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegram: "listener_name" }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("ok", true);
});
