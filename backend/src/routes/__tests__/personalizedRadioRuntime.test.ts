import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const mockRecommendRadio = jest.fn();
jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: Request, res: Response, next: NextFunction) => {
        if (req.header("x-test-auth") !== "ok")
            return res.status(401).json({ error: "Not authenticated" });
        if (req.header("x-test-owner") !== "missing")
            req.user = { id: "alice", username: "tester", role: "user" };
        next();
    },
}));
jest.mock("../../services/recommendations/recommendationRuntime", () => ({
    unifiedRecommendationService: {
        recommendRadio: (...args: unknown[]) => mockRecommendRadio(...args),
    },
}));
jest.mock("../../services/personalDailyMixes", () => ({
    personalDailyMixService: { getMixes: jest.fn() },
}));
jest.mock("../../services/recommendations/exposureStore", () => ({
    recommendationExposureStore: { markViewed: jest.fn() },
}));
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn() }) },
}));
import router from "../personalized";
import { createRouteTestApp } from "./helpers/createRouteTestApp";
import { LibrarySeedRadioError } from "../../services/librarySeedRadioError";
const app = createRouteTestApp("/api/personalized", router);
const responseBody = {
    tracks: [],
    radioOrigin: { kind: "track", source: "youtube", id: "seedVideo01" },
    generationId: "owned-generation",
    nextCursor: 1,
    degraded: false,
    degradedSources: [],
};
const get = (query: Record<string, unknown>) =>
    request(app)
        .get("/api/personalized/radio")
        .query(query)
        .set("x-test-auth", "ok");

describe("original-seed radio continuation boundary", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        mockRecommendRadio.mockResolvedValue(responseBody);
    });
    it("requires authentication before catalog work", async () => {
        expect(
            (
                await request(app).get(
                    "/api/personalized/radio?type=youtube&value=seedVideo01",
                )
            ).status,
        ).toBe(401);
        expect(mockRecommendRadio).not.toHaveBeenCalled();
    });
    it.each([
        [
            "youtube",
            "seedVideo01",
            { kind: "track", source: "youtube", id: "seedVideo01" },
        ],
        [
            "vibe",
            "local-track",
            { kind: "track", source: "library", id: "local-track" },
        ],
        [
            "artist",
            "local-artist",
            { kind: "artist", source: "library", id: "local-artist" },
        ],
        [
            "artist-name",
            "Ибрагим Маалуф",
            { kind: "artist", source: "discovery", name: "Ибрагим Маалуф" },
        ],
    ])(
        "preserves %s origin and returns ordered served membership",
        async (type, value, radioOrigin) => {
            const result = await get({
                type,
                value,
                cursor: "3",
                limit: "17",
                sessionId: "station-tab",
                exclude: "yt:queuedVid01,library:local-queued,local-queued",
            });
            expect(result.status).toBe(200);
            expect(result.body).toEqual(responseBody);
            expect(mockRecommendRadio).toHaveBeenCalledWith({
                userId: "alice",
                radioOrigin,
                cursor: 3,
                limit: 17,
                sessionId: "station-tab",
                exclude: [
                    "yt:queuedVid01",
                    "library:local-queued",
                    "local-queued",
                ],
            });
        },
    );
    it("uses bounded defaults and a server-generated session without inferring the current track", async () => {
        const result = await get({ type: "youtube", value: "seedVideo01" });
        expect(result.status).toBe(200);
        expect(mockRecommendRadio).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "alice",
                cursor: 0,
                limit: 25,
                exclude: [],
                sessionId: expect.any(String),
            }),
        );
    });
    it("passes only the explicit no-write diagnostic flag", async () => {
        await get({ type: "youtube", value: "seedVideo01" }).set(
            "x-soundspan-diagnostic",
            "playback",
        );
        expect(mockRecommendRadio).toHaveBeenCalledWith(
            expect.objectContaining({ diagnostic: true }),
        );
    });
    it.each([
        {},
        { type: "youtube", value: "short" },
        { type: "youtube", value: "yt:seedVideo01" },
        { type: "vibe", value: "../../secret" },
        { type: "artist-name", value: "bad\u0001name" },
        { type: "artist-name", value: "a".repeat(201) },
        { type: "playlist", value: "local" },
        { type: "youtube", value: "seedVideo01", userId: "bob" },
        { type: "youtube", value: "seedVideo01", limit: "26" },
        { type: "youtube", value: "seedVideo01", limit: ["1", "2"] },
        { type: "youtube", value: "seedVideo01", cursor: "1000001" },
        { type: "youtube", value: "seedVideo01", cursor: "-1" },
        { type: "youtube", value: "seedVideo01", sessionId: "x".repeat(129) },
        { type: "youtube", value: "seedVideo01", exclude: "yt:short" },
        {
            type: "youtube",
            value: "seedVideo01",
            exclude: "library:../private",
        },
        {
            type: "youtube",
            value: "seedVideo01",
            exclude: Array.from({ length: 81 }, (_, i) => `local-${i}`).join(
                ",",
            ),
        },
    ])(
        "rejects malformed or owner-injected query %# before selection",
        async (query) => {
            expect((await get(query)).status).toBe(400);
            expect(mockRecommendRadio).not.toHaveBeenCalled();
        },
    );
    it("requires the authenticated owner even when middleware has no account", async () => {
        expect(
            (
                await get({ type: "youtube", value: "seedVideo01" }).set(
                    "x-test-owner",
                    "missing",
                )
            ).status,
        ).toBe(401);
        expect(mockRecommendRadio).not.toHaveBeenCalled();
    });
    it("returns a missing original seed as 404 rather than an empty healthy station", async () => {
        mockRecommendRadio.mockRejectedValue(
            new LibrarySeedRadioError(404, "Track not found"),
        );
        const result = await get({ type: "vibe", value: "deleted-seed" });
        expect(result.status).toBe(404);
        expect(result.body).toMatchObject({ code: "RADIO_SEED_NOT_FOUND" });
    });
});
