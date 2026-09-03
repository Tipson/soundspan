import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

jest.mock("../../utils/db", () => ({
    prisma: { user: { findUnique: jest.fn() } },
}));
jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: () => ({ error: jest.fn() }),
    },
}));
jest.mock("../../services/recommendations/onlineAnalysisProgress", () => ({
    getOnlineAnalysisProgress: jest.fn(),
}));
process.env.JWT_SECRET = "online-analysis-test-only-secret";

const { requireAuth } = require("../../middleware/auth");
const router = require("../enrichmentOnlineAnalysis").default;
const { prisma } = require("../../utils/db");
const {
    getOnlineAnalysisProgress,
} = require("../../services/recommendations/onlineAnalysisProgress");
const app = express();
app.use("/api/enrichment/online-analysis", requireAuth, router);
const token = jwt.sign(
    { userId: "operator", tokenVersion: 0 },
    process.env.JWT_SECRET,
    { algorithm: "HS256" },
);

beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({
        id: "operator",
        username: "operator",
        role: "admin",
        tokenVersion: 0,
    });
    getOnlineAnalysisProgress.mockResolvedValue({
        total: 100,
        audio: { completed: 30 },
    });
});

test("anonymous callers cannot read server-wide counters", async () => {
    expect(
        (await request(app).get("/api/enrichment/online-analysis")).status,
    ).toBe(401);
    expect(getOnlineAnalysisProgress).not.toHaveBeenCalled();
});

test("ordinary accounts cannot read counters even with a valid token", async () => {
    prisma.user.findUnique.mockResolvedValue({
        id: "operator",
        username: "operator",
        role: "user",
        tokenVersion: 0,
    });
    expect(
        (
            await request(app)
                .get("/api/enrichment/online-analysis")
                .auth(token, { type: "bearer" })
        ).status,
    ).toBe(403);
    expect(getOnlineAnalysisProgress).not.toHaveBeenCalled();
});

test("administrators receive counters with no shared HTTP caching", async () => {
    const response = await request(app)
        .get("/api/enrichment/online-analysis")
        .auth(token, { type: "bearer" });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.audio.completed).toBe(30);
});

test("database failure is a safe error, not zero percent or leaked SQL", async () => {
    getOnlineAnalysisProgress.mockRejectedValue(
        new Error("private connection and SQL details"),
    );
    const response = await request(app)
        .get("/api/enrichment/online-analysis")
        .auth(token, { type: "bearer" });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
        error: "Failed to load online analysis progress",
    });
});
