import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const mockGetProfile = jest.fn();
const mockSaveProfile = jest.fn();
const mockSkipProfile = jest.fn();

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: Request, res: Response, next: NextFunction) => {
        const userId = req.header("x-test-user");
        if (!userId)
            return res.status(401).json({ error: "Not authenticated" });
        req.user = { id: userId, username: userId, role: "user" };
        return next();
    },
}));

jest.mock("../../services/tasteProfile", () => {
    class TasteProfileUnavailableError extends Error {}
    return {
        TasteProfileUnavailableError,
        tasteProfileService: {
            getProfile: (...args: unknown[]) => mockGetProfile(...args),
            saveProfile: (...args: unknown[]) => mockSaveProfile(...args),
            skipProfile: (...args: unknown[]) => mockSkipProfile(...args),
        },
    };
});

import router from "../tasteProfile";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/taste-profile", router);

describe("account taste profile routes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetProfile.mockResolvedValue({
            profile: null,
            completedAt: null,
            skippedAt: null,
            needsOnboarding: true,
        });
        mockSaveProfile.mockResolvedValue({
            profile: {
                genres: ["Rock"],
                artists: ["Muse", "Кино"],
                seedTracks: [],
            },
            completedAt: "2026-08-30T12:00:00.000Z",
            skippedAt: null,
            needsOnboarding: false,
        });
        mockSkipProfile.mockResolvedValue({
            profile: null,
            completedAt: null,
            skippedAt: "2026-08-30T12:00:00.000Z",
            needsOnboarding: false,
        });
    });

    it("requires authentication for reads and writes", async () => {
        const [read, write] = await Promise.all([
            request(app).get("/api/taste-profile"),
            request(app)
                .put("/api/taste-profile")
                .send({ genres: ["Rock"], artists: ["Muse", "Кино"] }),
        ]);

        expect(read.status).toBe(401);
        expect(write.status).toBe(401);
        expect(mockGetProfile).not.toHaveBeenCalled();
        expect(mockSaveProfile).not.toHaveBeenCalled();
    });

    it("uses only the authenticated account identity", async () => {
        await request(app)
            .get("/api/taste-profile")
            .set("x-test-user", "alice");
        await request(app)
            .put("/api/taste-profile")
            .set("x-test-user", "bob")
            .send({ genres: ["Rock"], artists: ["Muse", "Кино"] });

        expect(mockGetProfile).toHaveBeenCalledWith("alice");
        expect(mockSaveProfile).toHaveBeenCalledWith("bob", {
            genres: ["Rock"],
            artists: ["Muse", "Кино"],
        });
    });

    it.each(["post", "put"])(
        "accepts a valid profile through %s",
        async (method) => {
            const response = await request(app)
                [method as "post" | "put"]("/api/taste-profile")
                .set("x-test-user", "alice")
                .send({
                    genres: [" Rock ", "Metal"],
                    artists: ["Muse"],
                });

            expect(response.status).toBe(200);
            expect(mockSaveProfile).toHaveBeenCalledWith("alice", {
                genres: ["Rock", "Metal"],
                artists: ["Muse"],
            });
        },
    );

    it.each([
        {},
        { genres: ["Rock"], artists: ["Muse"] },
        { genres: Array.from({ length: 11 }, (_, index) => `Genre ${index}`) },
        { genres: ["Rock", "Metal", "Pop"], unexpected: true },
        { skip: true, genres: ["Rock"] },
        { genres: ["Rock\nMetal", "Pop"], artists: ["Muse"] },
    ])("rejects an invalid payload %#", async (body) => {
        const response = await request(app)
            .put("/api/taste-profile")
            .set("x-test-user", "alice")
            .send(body);

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: "Invalid taste profile",
            code: "INVALID_TASTE_PROFILE",
        });
        expect(mockSaveProfile).not.toHaveBeenCalled();
        expect(mockSkipProfile).not.toHaveBeenCalled();
    });

    it("stores a skip against the authenticated account", async () => {
        const response = await request(app)
            .post("/api/taste-profile")
            .set("x-test-user", "bob")
            .send({ skip: true });

        expect(response.status).toBe(200);
        expect(mockSkipProfile).toHaveBeenCalledWith("bob");
        expect(mockSaveProfile).not.toHaveBeenCalled();
    });

    it("returns a static 503 when no playable provider seed can be resolved", async () => {
        const { TasteProfileUnavailableError } = jest.requireMock(
            "../../services/tasteProfile",
        ) as { TasteProfileUnavailableError: new () => Error };
        mockSaveProfile.mockRejectedValueOnce(
            new TasteProfileUnavailableError(),
        );

        const response = await request(app)
            .put("/api/taste-profile")
            .set("x-test-user", "alice")
            .send({ genres: ["Rock"], artists: ["Muse", "Кино"] });

        expect(response.status).toBe(503);
        expect(response.body).toEqual({
            error: "Music provider could not resolve taste seeds",
            code: "TASTE_PROVIDER_UNAVAILABLE",
        });
    });
});
