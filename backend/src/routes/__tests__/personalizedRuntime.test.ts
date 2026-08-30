import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const mockGetHomeFeed = jest.fn();

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: Request, res: Response, next: NextFunction) => {
        if (req.header("x-test-auth") !== "ok") {
            return res.status(401).json({ error: "Not authenticated" });
        }
        req.user = { id: "user-1", username: "tester", role: "user" };
        next();
    },
}));

jest.mock("../../services/personalizedCatalog", () => ({
    personalizedCatalogService: {
        getHomeFeed: (...args: unknown[]) => mockGetHomeFeed(...args),
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
        mockGetHomeFeed.mockResolvedValue({
            shelves: {
                listenAgain: [],
                quickPicks: [],
                discovery: [],
            },
            degraded: false,
            reason: "insufficient_signals",
            seedCount: 0,
        });
    });

    it("requires authentication", async () => {
        const response = await request(app).get("/api/personalized/home");

        expect(response.status).toBe(401);
        expect(mockGetHomeFeed).not.toHaveBeenCalled();
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
        mockGetHomeFeed.mockResolvedValueOnce(payload);

        const response = await request(app)
            .get("/api/personalized/home")
            .set("x-test-auth", "ok");

        expect(response.status).toBe(200);
        expect(response.body).toEqual(payload);
        expect(mockGetHomeFeed).toHaveBeenCalledWith("user-1", 12);
    });

    it("accepts a bounded integer limit", async () => {
        const response = await request(app)
            .get("/api/personalized/home?limit=25")
            .set("x-test-auth", "ok");

        expect(response.status).toBe(200);
        expect(mockGetHomeFeed).toHaveBeenCalledWith("user-1", 25);
    });

    it.each(["for-you", "new", "familiar"])(
        "forwards the supported %s Wave mode",
        async (mode) => {
            const response = await request(app)
                .get(`/api/personalized/home?mode=${mode}`)
                .set("x-test-auth", "ok");

            expect(response.status).toBe(200);
            expect(mockGetHomeFeed).toHaveBeenCalledWith("user-1", 12, {
                mode,
            });
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
        expect(mockGetHomeFeed).toHaveBeenCalledWith("user-1", 12, {
            mode: "new",
            mood,
        });
    });

    it("forwards a bounded continuation cursor and canonical provider exclusions", async () => {
        const response = await request(app)
            .get(
                "/api/personalized/home?limit=25&cursor=7&exclude=yt%3Afirst%2Csecond%2Cfirst",
            )
            .set("x-test-auth", "ok");

        expect(response.status).toBe(200);
        expect(mockGetHomeFeed).toHaveBeenCalledWith("user-1", 25, {
            cursor: 7,
            excludeVideoIds: ["first", "second"],
        });
    });

    it.each([
        "cursor=-1",
        "cursor=1.5",
        "exclude=bad%20id",
        "mode=random",
        "mood=random",
        `exclude=${Array.from({ length: 81 }, (_, index) => `id-${index}`).join(
            "%2C",
        )}`,
    ])("rejects invalid continuation query %s", async (query) => {
        const response = await request(app)
            .get(`/api/personalized/home?${query}`)
            .set("x-test-auth", "ok");

        expect(response.status).toBe(400);
        expect(mockGetHomeFeed).not.toHaveBeenCalled();
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
            expect(mockGetHomeFeed).not.toHaveBeenCalled();
        },
    );
});
