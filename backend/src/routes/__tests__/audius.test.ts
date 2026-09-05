import type { NextFunction, Request, Response } from "express";
import express from "express";
import request from "supertest";

const mockSearch = jest.fn();
const mockResolveStream = jest.fn();
jest.mock("../../services/audius", () => ({
    ...jest.requireActual("../../services/audius"),
    audiusService: { search: mockSearch, resolveStream: mockResolveStream },
}));
jest.mock("../../config", () => ({ config: { features: { audius: false } } }));
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: Request, res: Response, next: NextFunction) => {
        if (req.headers.authorization !== "Bearer private-fixture")
            return res.status(401).json({ error: "Not authenticated" });
        req.user = { id: "user-1", username: "fixture", role: "user" };
        next();
    },
}));
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn(), error: jest.fn() }) },
}));

import router from "../audius";
import { config } from "../../config";
import { AudiusError } from "../../services/audius";

const app = express();
app.use("/api/audius", router);

describe("opt-in authenticated Audius API", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        config.features.audius = true;
    });

    it("requires authentication and returns disabled without calling the provider", async () => {
        expect(
            (await request(app).get("/api/audius/search?query=RAC")).status,
        ).toBe(401);
        config.features.audius = false;
        const response = await request(app)
            .get("/api/audius/search?query=RAC")
            .set("Authorization", "Bearer private-fixture");
        expect(response.status).toBe(404);
        expect(mockSearch).not.toHaveBeenCalled();
    });

    it("validates query shape before metadata I/O and returns source-labelled results", async () => {
        for (const query of [
            "",
            "query=RAC&limit=1oops",
            "query=RAC&query=Other",
            "query=RAC&limit=21",
        ]) {
            const response = await request(app)
                .get(`/api/audius/search?${query}`)
                .set("Authorization", "Bearer private-fixture");
            expect(response.status).toBe(400);
        }
        expect(mockSearch).not.toHaveBeenCalled();
        mockSearch.mockResolvedValueOnce([
            { source: "audius", id: "7AlA9", title: "Sinners" },
        ]);
        const response = await request(app)
            .get("/api/audius/search?query=RAC&limit=3")
            .set("Authorization", "Bearer private-fixture");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            source: "audius",
            tracks: [{ source: "audius", id: "7AlA9", title: "Sinners" }],
        });
        expect(mockSearch).toHaveBeenCalledWith(
            "RAC",
            3,
            expect.any(AbortSignal),
        );
    });

    it("returns public playback URL as JSON without forwarding credentials in a redirect", async () => {
        const streamUrl =
            "https://api.audius.co/v1/tracks/7AlA9/stream?app_name=Soundspan";
        mockResolveStream.mockResolvedValueOnce(streamUrl);
        const response = await request(app)
            .get("/api/audius/tracks/7AlA9/playback")
            .set("Authorization", "Bearer private-fixture");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            source: "audius",
            trackId: "7AlA9",
            streamUrl,
        });
        expect(response.headers.location).toBeUndefined();
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(JSON.stringify(response.body)).not.toContain("private-fixture");
        expect(mockResolveStream).toHaveBeenCalledWith(
            "7AlA9",
            expect.any(AbortSignal),
        );
    });

    it("returns sanitized access failures and never falls back to another track", async () => {
        mockResolveStream.mockRejectedValueOnce(
            new AudiusError(
                "Audius full stream is not available for this track",
                422,
            ),
        );
        const response = await request(app)
            .get("/api/audius/tracks/7AlA9/playback")
            .set("Authorization", "Bearer private-fixture");
        expect(response.status).toBe(422);
        expect(response.body).toEqual({
            error: "Audius full stream is not available for this track",
        });
        mockSearch.mockRejectedValueOnce(new Error("provider token=private"));
        const failure = await request(app)
            .get("/api/audius/search?query=RAC")
            .set("Authorization", "Bearer private-fixture");
        expect(failure.status).toBe(502);
        expect(JSON.stringify(failure.body)).not.toContain("private");
    });
});
