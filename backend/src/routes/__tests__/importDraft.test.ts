import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const mockCreateDraft = jest.fn();
const mockConfirmDraft = jest.fn();
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: Request, res: Response, next: NextFunction) => {
        if (req.header("x-test-owner") !== "owner-a") {
            return res.status(401).json({ error: "Not authenticated" });
        }
        req.user = { id: "owner-a", username: "fixture", role: "user" };
        next();
    },
}));
jest.mock("../../utils/logger", () => {
    const logger = {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);
    return { logger };
});
jest.mock("../../services/playlistImportService", () => ({
    playlistImportService: {},
}));
jest.mock("../../services/importJobStore", () => ({ importJobStore: {} }));
jest.mock("../../services/genericImportJobRunner", () => ({
    genericImportJobRunner: { enqueue: jest.fn() },
}));
jest.mock(
    "../../services/importDraftService",
    () => ({
        importDraftService: {
            create: mockCreateDraft,
            confirm: mockConfirmDraft,
        },
    }),
    { virtual: true },
);

import router from "../playlistImport";
import { logger } from "../../utils/logger";
import { createRouteTestApp } from "./helpers/createRouteTestApp";
const app = createRouteTestApp("/api/import", router);

describe("owner import draft routes", () => {
    beforeEach(() => jest.clearAllMocks());

    it("requires authentication before accepting a file draft", async () => {
        const result = await request(app)
            .post("/api/import/drafts")
            .send({ format: "text", content: "Artist - Song" });
        expect(result.status).toBe(401);
        expect(mockCreateDraft).not.toHaveBeenCalled();
    });

    it("creates an owner-bound text draft without importing collection effects", async () => {
        mockCreateDraft.mockResolvedValue({
            id: "draft-a",
            userId: "owner-a",
            status: "draft",
            draftRevision: 1,
        });
        const result = await request(app)
            .post("/api/import/drafts")
            .set("x-test-owner", "owner-a")
            .send({
                format: "text",
                content: "Artist - Song\nArtist - Song",
                name: "One source",
                userId: "owner-b",
            });
        expect(result.status).toBe(201);
        expect(mockCreateDraft).toHaveBeenCalledWith("owner-a", {
            format: "text",
            content: "Artist - Song\nArtist - Song",
            name: "One source",
        });
        expect(result.body.job.status).toBe("draft");
    });

    it("rejects forged client matching identities instead of confirming them", async () => {
        const result = await request(app)
            .post("/api/import/drafts/draft-a/confirm")
            .set("x-test-owner", "owner-a")
            .send({
                revision: 1,
                mappingDigest: "a".repeat(64),
                categories: ["playlists"],
                resolvedTracks: [{ trackId: "private-foreign-track" }],
            });
        expect(result.status).toBe(400);
        expect(mockConfirmDraft).not.toHaveBeenCalled();
    });

    it.each(["Error", "unknown"])(
        "keeps unexpected %s failures generic in both HTTP and bounded logs",
        async (classification) => {
            const sensitive =
                "sensitive-provider-token-and-private-upload-content";
            const failure =
                classification === "Error"
                    ? Object.assign(new Error(sensitive), { name: sensitive })
                    : { name: sensitive, message: sensitive };
            mockCreateDraft.mockRejectedValueOnce(failure);
            const result = await request(app)
                .post("/api/import/drafts")
                .set("x-test-owner", "owner-a")
                .send({ format: "text", content: "Artist - Song" });
            expect(result.status).toBe(500);
            expect(result.body).toEqual({ error: "import_draft_failed" });
            expect(logger.error).toHaveBeenCalledTimes(1);
            expect(logger.error).toHaveBeenCalledWith(
                "Import draft operation failed",
                { errorType: classification },
            );
            expect(
                JSON.stringify([
                    result.body,
                    (logger.error as jest.Mock).mock.calls,
                ]),
            ).not.toContain(sensitive);
        },
    );
});
