import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const mockGetPersonalizedFeed = jest.fn();

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: Request, res: Response, next: NextFunction) => {
        if (req.header("x-test-auth") !== "ok") {
            return res.status(401).json({ error: "Not authenticated" });
        }
        req.user = { id: "user-1", username: "tester", role: "user" };
        next();
    },
}));

jest.mock("../../services/recommendations/recommendationRuntime", () => ({
    unifiedRecommendationService: {
        getPersonalizedFeed: (...args: unknown[]) =>
            mockGetPersonalizedFeed(...args),
    },
}));

jest.mock("../../utils/logger", () => {
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);
    return { logger };
});

import router from "../personalized";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/personalized", router);

describe("GET /api/personalized/home", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetPersonalizedFeed.mockResolvedValue({
            shelves: {
                listenAgain: [],
                quickPicks: [],
                discovery: [],
            },
            degraded: false,
            reason: "insufficient_signals",
            seedCount: 0,
            generationId: "generation-default",
            degradedSources: [],
        });
    });

    it("requires authentication", async () => {
        const response = await request(app).get("/api/personalized/home");

        expect(response.status).toBe(401);
        expect(mockGetPersonalizedFeed).not.toHaveBeenCalled();
    });

    it("uses the authenticated user and default shelf limit", async () => {
        const payload = {
            shelves: {
                listenAgain: [],
                quickPicks: [
                    {
                        id: "yt:video-1",
                        title: "Track",
                        duration: 180,
                        trackNo: null,
                        artist: { id: null, name: "Artist" },
                        album: {
                            id: null,
                            title: "Album",
                            coverArt: "https://img.example/video-1.jpg",
                            artist: { id: null, name: "Artist" },
                        },
                        source: "youtube",
                        streamSource: "youtube",
                        youtubeVideoId: "video-1",
                        provider: {
                            tidalTrackId: null,
                            youtubeVideoId: "video-1",
                        },
                    },
                ],
                discovery: [],
            },
            degraded: false,
            reason: null,
            seedCount: 1,
        };
        mockGetPersonalizedFeed.mockResolvedValueOnce(payload);

        const response = await request(app)
            .get("/api/personalized/home")
            .set("x-test-auth", "ok");

        expect(response.status).toBe(200);
        expect(response.body).toEqual(payload);
        expect(mockGetPersonalizedFeed).toHaveBeenCalledWith({
            userId: "user-1",
            sessionId: expect.any(String),
            surface: "home",
            limit: 12,
            cursor: 0,
            direction: "for-you",
            mood: null,
            excludeVideoIds: [],
        });
    });

    it("accepts a bounded integer limit", async () => {
        const response = await request(app)
            .get("/api/personalized/home?limit=25")
            .set("x-test-auth", "ok");

        expect(response.status).toBe(200);
        expect(mockGetPersonalizedFeed).toHaveBeenCalledWith(
            expect.objectContaining({ userId: "user-1", limit: 25 }),
        );
    });

    it.each(["for-you", "new", "familiar"])(
        "forwards the supported %s Wave mode",
        async (mode) => {
            const response = await request(app)
                .get(`/api/personalized/home?mode=${mode}`)
                .set("x-test-auth", "ok");

            expect(response.status).toBe(200);
            expect(mockGetPersonalizedFeed).toHaveBeenCalledWith(
                expect.objectContaining({ direction: mode }),
            );
        },
    );

    it.each([
        "calm",
        "energetic",
        "focus",
        "workout",
        "favorites",
        "forgotten",
    ])("forwards the supported %s Wave mood independently", async (mood) => {
        const response = await request(app)
            .get(`/api/personalized/home?mode=new&mood=${mood}`)
            .set("x-test-auth", "ok");

        expect(response.status).toBe(200);
        expect(mockGetPersonalizedFeed).toHaveBeenCalledWith(
            expect.objectContaining({ direction: "new", mood }),
        );
    });

    it("forwards a bounded continuation cursor and canonical provider exclusions", async () => {
        const response = await request(app)
            .get(
                "/api/personalized/home?limit=25&cursor=7&exclude=yt%3Afirst%2Csecond%2Cfirst",
            )
            .set("x-test-auth", "ok");

        expect(response.status).toBe(200);
        expect(mockGetPersonalizedFeed).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "user-1",
                limit: 25,
                cursor: 7,
                excludeVideoIds: ["first", "second"],
            }),
        );
    });

    it.each(["home", "wave", "made-for-you"])(
        "forwards the %s surface and stable client session",
        async (surface) => {
            const response = await request(app)
                .get(
                    `/api/personalized/home?surface=${surface}&sessionId=tab-session-1`,
                )
                .set("x-test-auth", "ok");

            expect(response.status).toBe(200);
            expect(mockGetPersonalizedFeed).toHaveBeenCalledWith(
                expect.objectContaining({
                    surface,
                    sessionId: "tab-session-1",
                }),
            );
        },
    );

    it.each([
        "cursor=-1",
        "cursor=1.5",
        "exclude=bad%20id",
        "mode=random",
        "mood=random",
        "surface=search",
        "sessionId=%20",
        `exclude=${Array.from({ length: 81 }, (_, index) => `id-${index}`).join(
            "%2C",
        )}`,
    ])("rejects invalid continuation query %s", async (query) => {
        const response = await request(app)
            .get(`/api/personalized/home?${query}`)
            .set("x-test-auth", "ok");

        expect(response.status).toBe(400);
        expect(mockGetPersonalizedFeed).not.toHaveBeenCalled();
    });

    it.each(["0", "26", "1.5", "many"])(
        "rejects invalid limit %s at the HTTP boundary",
        async (limit) => {
            const response = await request(app)
                .get(`/api/personalized/home?limit=${limit}`)
                .set("x-test-auth", "ok");

            expect(response.status).toBe(400);
            expect(response.body).toEqual({
                error: "Invalid personalized home feed query",
                code: "INVALID_QUERY",
            });
            expect(mockGetPersonalizedFeed).not.toHaveBeenCalled();
        },
    );
});
