import request from "supertest";

const mockEnqueue = jest.fn();

jest.mock("../../config", () => ({
    config: { internalApiSecret: "canonical-test-secret" },
}));
jest.mock("../../services/recommendations/canonicalIdentityPromotion", () => ({
    enqueueCanonicalIdentityPromotion: (...args: unknown[]) =>
        mockEnqueue(...args),
}));
jest.mock("../../utils/logger", () => {
    const channel = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    };
    return { logger: { ...channel, child: jest.fn(() => channel) } };
});

import router from "../internalCanonicalIdentity";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/internal/canonical-identity", router);
const validBody = {
    sourceCanonicalId: "canonical-source",
    expectedFingerprint: "fingerprint-value",
    recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
    confidence: 0.99,
};

describe("internal canonical identity promotion route", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockEnqueue.mockResolvedValue("accepted");
    });

    it.each([undefined, "wrong-secret"])(
        "fails closed before database work for secret %s",
        async (secret) => {
            const call = request(app)
                .post("/api/internal/canonical-identity/promotions")
                .send(validBody);
            if (secret) call.set("x-internal-secret", secret);
            const response = await call;

            expect(response.status).toBe(403);
            expect(response.body).toEqual({ error: "Forbidden" });
            expect(mockEnqueue).not.toHaveBeenCalled();
        },
    );

    it("validates the bounded machine payload", async () => {
        const response = await request(app)
            .post("/api/internal/canonical-identity/promotions")
            .set("x-internal-secret", "canonical-test-secret")
            .send({ ...validBody, confidence: 2 });

        expect(response.status).toBe(400);
        expect(mockEnqueue).not.toHaveBeenCalled();

        const emptyResponse = await request(app)
            .post("/api/internal/canonical-identity/promotions")
            .set("x-internal-secret", "canonical-test-secret");
        expect(emptyResponse.status).toBe(400);

        const invalidMbid = await request(app)
            .post("/api/internal/canonical-identity/promotions")
            .set("x-internal-secret", "canonical-test-secret")
            .send({ ...validBody, recordingMbid: "not-an-mbid" });
        expect(invalidMbid.status).toBe(400);
    });

    it("accepts a durable promotion handoff", async () => {
        const response = await request(app)
            .post("/api/internal/canonical-identity/promotions")
            .set("x-internal-secret", "canonical-test-secret")
            .send(validBody);

        expect(response.status).toBe(202);
        expect(response.body).toEqual({ status: "accepted" });
        expect(mockEnqueue).toHaveBeenCalledWith(validBody);
    });

    it("reports a stale fingerprint without publishing an intent", async () => {
        mockEnqueue.mockResolvedValueOnce("stale");
        const response = await request(app)
            .post("/api/internal/canonical-identity/promotions")
            .set("x-internal-secret", "canonical-test-secret")
            .send(validBody);

        expect(response.status).toBe(409);
        expect(response.body).toEqual({ status: "stale" });
    });

    it("keeps storage failures generic", async () => {
        mockEnqueue.mockRejectedValueOnce(new Error("database-secret-detail"));
        const response = await request(app)
            .post("/api/internal/canonical-identity/promotions")
            .set("x-internal-secret", "canonical-test-secret")
            .send(validBody);

        expect(response.status).toBe(503);
        expect(response.body).toEqual({
            error: "Promotion handoff unavailable",
        });
        expect(JSON.stringify(response.body)).not.toContain(
            "database-secret-detail",
        );
    });
});
