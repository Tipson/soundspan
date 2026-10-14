import express from "express";
import request from "supertest";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: () => void) => {
        req.user = { id: "conditions-user" };
        next();
    },
}));
jest.mock("../../middleware/rateLimiter", () => ({
    playbackStateLimiter: (_req: any, _res: any, next: () => void) => next(),
}));
jest.mock("../../utils/logger", () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        child: jest.fn(() => ({ error: jest.fn(), warn: jest.fn() })),
    },
}));
const mockPublish = jest.fn();
jest.mock("../../services/socialPresenceEvents", () => ({
    publishSocialPresenceUpdate: (...args: unknown[]) => mockPublish(...args),
}));
const mockDb = {
    playbackState: {
        findUnique: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
};
jest.mock("../../utils/db", () => ({
    prisma: mockDb,
    Prisma: jest.requireActual("@prisma/client").Prisma,
}));
import router from "../playbackState";

const revision = "11111111-1111-4111-8111-111111111111";
const app = express().use(express.json()).use(router);

describe("conditional playback-state HTTP contract", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        mockDb.$transaction.mockImplementation((run: any) => run(mockDb));
        mockDb.playbackState.upsert.mockResolvedValue({ revision });
        mockDb.playbackState.deleteMany.mockResolvedValue({ count: 1 });
    });

    it.each(["post", "delete"] as const)(
        "requires If-Match for %s without effects",
        async (method) => {
            const response = await request(app)
                [method]("/")
                .send({ playbackType: "track" });
            expect(response.status).toBe(428);
            expect(mockDb.playbackState.upsert).not.toHaveBeenCalled();
            expect(mockDb.playbackState.create).not.toHaveBeenCalled();
            expect(mockDb.playbackState.updateMany).not.toHaveBeenCalled();
            expect(mockDb.playbackState.deleteMany).not.toHaveBeenCalled();
            expect(mockPublish).not.toHaveBeenCalled();
        },
    );

    it.each([
        "*",
        'W/"ps1.absent"',
        '"ps1.absent", "ps1.absent"',
        '"old"',
        "ps1.absent",
        '"ps1.not-a-uuid"',
    ])("rejects malformed If-Match %s", async (etag) => {
        for (const method of ["post", "delete"] as const) {
            const response = await request(app)
                [method]("/")
                .set("If-Match", etag)
                .send({ playbackType: "track" });
            expect(response.status).toBe(400);
        }
        expect(mockPublish).not.toHaveBeenCalled();
        expect(mockDb.playbackState.create).not.toHaveBeenCalled();
    });

    it("returns absent lease with legacy payload without copying it", async () => {
        const legacy = {
            deviceId: "legacy",
            queue: [{ id: "legacy" }],
            revision,
        };
        mockDb.playbackState.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(legacy);
        const response = await request(app)
            .get("/")
            .set("X-Playback-Device-Id", "browser");
        expect(response.status).toBe(200);
        expect(response.body).toEqual(legacy);
        expect(response.headers.etag).toBe('"ps1.absent"');
        expect(response.headers["x-playback-state-protocol"]).toBe("1");
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(mockDb.playbackState.upsert).not.toHaveBeenCalled();
        expect(mockDb.playbackState.create).not.toHaveBeenCalled();
    });

    it("returns own tombstone lease without reading legacy", async () => {
        mockDb.playbackState.findUnique.mockResolvedValue({
            revision,
            isCleared: true,
        });
        const response = await request(app)
            .get("/")
            .set("X-Playback-Device-Id", "browser");
        expect(response.status).toBe(200);
        expect(response.body).toBeNull();
        expect(response.headers.etag).toBe(`"ps1.${revision}"`);
        expect(mockDb.playbackState.findUnique).toHaveBeenCalledTimes(1);
    });

    it.each(["post", "delete"] as const)(
        "returns 412 for stale %s without presence publication",
        async (method) => {
            mockDb.playbackState.updateMany.mockResolvedValue({ count: 0 });
            const response = await request(app)
                [method]("/")
                .set("If-Match", `"ps1.${revision}"`)
                .send({ playbackType: "track" });
            expect(response.status).toBe(412);
            expect(mockPublish).not.toHaveBeenCalled();
        },
    );

    it.each(["post", "delete"] as const)(
        "turns an absent-slot unique race into 412 for %s",
        async (method) => {
            mockDb.playbackState.create.mockRejectedValue({ code: "P2002" });
            const response = await request(app)
                [method]("/")
                .set("If-Match", '"ps1.absent"')
                .send({ playbackType: "track" });
            expect(response.status).toBe(412);
            expect(mockPublish).not.toHaveBeenCalled();
        },
    );

    it("retries only the audiobook FK once with null audiobookId", async () => {
        mockDb.playbackState.create
            .mockRejectedValueOnce({
                code: "P2003",
                meta: { constraint: "PlaybackState_audiobookId_fkey" },
            })
            .mockImplementationOnce(async ({ data }) => ({
                ...data,
                revision,
            }));
        const response = await request(app)
            .post("/")
            .set("If-Match", '"ps1.absent"')
            .send({
                playbackType: "audiobook",
                audiobookId: "gone",
                currentTime: 12.75,
            });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            audiobookId: null,
            currentTime: 12.75,
        });
        expect(mockDb.playbackState.create).toHaveBeenCalledTimes(2);
    });

    it.each([
        undefined,
        "PlaybackState_userId_fkey",
        "PlaybackState_audiobookId_fkey",
    ])("does not repeatedly retry a failing FK %s", async (constraint) => {
        mockDb.playbackState.create.mockRejectedValue({
            code: "P2003",
            ...(constraint ? { meta: { constraint } } : {}),
        });
        const response = await request(app)
            .post("/")
            .set("If-Match", '"ps1.absent"')
            .send({ playbackType: "audiobook", audiobookId: "gone" });
        expect(response.status).toBe(500);
        expect(mockDb.playbackState.create).toHaveBeenCalledTimes(
            constraint === "PlaybackState_audiobookId_fkey" ? 2 : 1,
        );
        expect(mockPublish).not.toHaveBeenCalled();
    });
});
