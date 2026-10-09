import type { NextFunction, Request, Response } from "express";
import request from "supertest";
const mockNativeRouteRadio = jest.fn(),
    mockNativeViewed = jest.fn();
jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: Request, res: Response, next: NextFunction) => {
        if (req.header("x-test-owner") !== "alice")
            return res.status(401).json({ error: "auth" });
        req.user = { id: "alice", username: "tester", role: "user" };
        next();
    },
}));
jest.mock("../../services/recommendations/recommendationRuntime", () => ({
    unifiedRecommendationService: {
        recommendRadio: (...args: unknown[]) => mockNativeRouteRadio(...args),
    },
}));
jest.mock("../../services/recommendations/exposureStore", () => ({
    recommendationExposureStore: {
        markViewed: (...args: unknown[]) => mockNativeViewed(...args),
    },
}));
jest.mock("../../services/personalDailyMixes", () => ({
    personalDailyMixService: { getMixes: jest.fn() },
}));
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn() }) },
}));
import router from "../personalized";
import { createRouteTestApp } from "./helpers/createRouteTestApp";
const app = createRouteTestApp("/api/personalized", router);
beforeEach(() => {
    jest.clearAllMocks();
    mockNativeRouteRadio.mockResolvedValue({
        tracks: [],
        generationId: "g",
        degraded: false,
    });
    mockNativeViewed.mockResolvedValue(1);
});
describe("authenticated native original radio and exact impressions", () => {
    it.each([
        ["vk", "-001_002"],
        ["yandex", "0007"],
    ] as const)(
        "preserves exact %s original seed and mixed queue namespaces",
        async (provider, id) => {
            const response = await request(app)
                .get("/api/personalized/radio")
                .set("x-test-owner", "alice")
                .query({
                    type: provider,
                    value: id,
                    sessionId: "tab",
                    cursor: 0,
                    limit: 25,
                    exclude:
                        "vk:-001_002,yandex:0007,yandex:7,yt:queuedVid01,library:local",
                });
            expect(response.status).toBe(200);
            expect(mockNativeRouteRadio).toHaveBeenCalledWith(
                {
                    userId: "alice",
                    sessionId: "tab",
                    radioOrigin: { kind: "track", source: provider, id },
                    cursor: 0,
                    limit: 25,
                    exclude: [
                        "vk:-001_002",
                        "yandex:0007",
                        "yandex:7",
                        "yt:queuedVid01",
                        "library:local",
                    ],
                },
                { signal: expect.any(AbortSignal) },
            );
        },
    );
    it.each([
        ["vk", "-1_2"],
        ["yandex", "0007"],
    ] as const)(
        "passes owned %s impressions with the uncoerced recording ID",
        async (provider, providerTrackId) => {
            const response = await request(app)
                .post("/api/personalized/impressions")
                .set("x-test-owner", "alice")
                .send({
                    generationId: "g",
                    tracks: [{ provider, providerTrackId }],
                });
            expect(response.status).toBe(200);
            expect(mockNativeViewed).toHaveBeenCalledWith({
                userId: "alice",
                generationId: "g",
                viewedAt: expect.any(Date),
                tracks: [{ provider, providerTrackId }],
            });
        },
    );
    it("keeps native diagnostics read-only and requires an authenticated owner", async () => {
        const body = {
            generationId: "g",
            tracks: [{ provider: "yandex", providerTrackId: "0007" }],
        };
        expect(
            (
                await request(app)
                    .post("/api/personalized/impressions")
                    .send(body)
            ).status,
        ).toBe(401);
        expect(
            (
                await request(app)
                    .post("/api/personalized/impressions")
                    .set("x-test-owner", "alice")
                    .set("x-soundspan-diagnostic", "playback")
                    .send(body)
            ).body,
        ).toEqual({ recorded: 0, diagnostic: true });
        expect(mockNativeViewed).not.toHaveBeenCalled();
    });
    it.each([
        { type: "vk", value: "7" },
        { type: "yandex", value: "-1_2" },
        { type: "yandex", value: "7&token=secret" },
        { type: "vk", value: "-1_2", exclude: "yandex:-1_2" },
        { type: "yandex", value: "7", exclude: "vk:bad" },
        { type: "yandex", value: "7", nativeArtistId: "7" },
    ])(
        "rejects unsupported or conflicting native station query before source work: %j",
        async (query) => {
            expect(
                (
                    await request(app)
                        .get("/api/personalized/radio")
                        .set("x-test-owner", "alice")
                        .query(query)
                ).status,
            ).toBe(400);
            expect(mockNativeRouteRadio).not.toHaveBeenCalled();
        },
    );
    it.each([
        { provider: "vk", providerTrackId: "7" },
        { provider: "yandex", providerTrackId: "-1_2" },
        { provider: "yandex", providerTrackId: 7 },
        { provider: "yandex", providerTrackId: "7?token=secret" },
        { provider: "vk", providerTrackId: "-1_2", sourceUrl: "secret" },
    ])(
        "rejects malformed native impression identity without writes: %j",
        async (track) => {
            expect(
                (
                    await request(app)
                        .post("/api/personalized/impressions")
                        .set("x-test-owner", "alice")
                        .send({ generationId: "g", tracks: [track] })
                ).status,
            ).toBe(400);
            expect(mockNativeViewed).not.toHaveBeenCalled();
        },
    );
});
