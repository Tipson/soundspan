import type { NextFunction, Request, Response } from "express";
import request from "supertest";
const mockFeed = jest.fn();
jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: Request, _res: Response, next: NextFunction) => {
        req.user = { id: "owner", username: "test", role: "user" };
        next();
    },
}));
jest.mock("../../services/recommendations/recommendationRuntime", () => ({
    unifiedRecommendationService: {
        getPersonalizedFeed: (...args: unknown[]) => mockFeed(...args),
    },
}));
jest.mock("../../services/personalDailyMixes", () => ({
    personalDailyMixService: { getMixes: jest.fn() },
}));
jest.mock("../../services/recommendations/exposureStore", () => ({
    recommendationExposureStore: { markViewed: jest.fn() },
}));
import router from "../personalized";
import { RadioRequestError } from "../../services/recommendations/radioRequestExecution";
import { createRouteTestApp } from "./helpers/createRouteTestApp";
const app = createRouteTestApp("/api/personalized", router);
beforeEach(() => {
    jest.clearAllMocks();
    mockFeed.mockResolvedValue({
        shelves: { listenAgain: [], quickPicks: [], discovery: [] },
        degraded: false,
    });
});
it("preserves native prefixed exclusions and exact zeroes alongside legacy YouTube IDs", async () => {
    const response = await request(app).get("/api/personalized/home").query({
        surface: "wave",
        exclude: "vk:-01_0002,yandex:0002,yt:legacy,legacy",
    });
    expect(response.status).toBe(200);
    expect(mockFeed).toHaveBeenCalledWith(
        expect.objectContaining({
            userId: "owner",
            excludeVideoIds: ["vk:-01_0002", "yandex:0002", "legacy"],
        }),
        { signal: expect.any(AbortSignal) },
    );
});
it.each(["vk:1", "yandex:+2", "vk:-1_2:extra", "yandex:2.0", "yt:vk:-1_2"])(
    "rejects contradictory native query %s",
    async (exclude) => {
        expect(
            (
                await request(app)
                    .get("/api/personalized/home")
                    .query({ exclude })
            ).status,
        ).toBe(400);
        expect(mockFeed).not.toHaveBeenCalled();
    },
);
it("reports the actual personal deadline as static504 without source or caller details", async () => {
    mockFeed.mockRejectedValue(new RadioRequestError("RADIO_REQUEST_TIMEOUT"));
    const response = await request(app).get("/api/personalized/home");
    expect(response.status).toBe(504);
    expect(response.body).toEqual({
        error: "Personalized request timed out",
        code: "RADIO_REQUEST_TIMEOUT",
    });
});
