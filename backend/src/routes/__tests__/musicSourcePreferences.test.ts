import type { Request } from "express";
import express from "express";
import request from "supertest";

const mockPrisma = {
    trackMusicSource: { findUnique: jest.fn() },
    trackYtMusic: { findUnique: jest.fn() },
    trackTidal: { findUnique: jest.fn() },
    likedRemoteTrack: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
    dislikedEntity: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
    remotePreferenceIntent: {
        upsert: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
};
const mockEnsureRemoteTrack = jest.fn();
const mockResolveMetadata = jest.fn();
jest.mock("../../utils/db", () => ({ prisma: mockPrisma }));
jest.mock("../../services/trackMappingService", () => ({
    trackMappingService: { ensureRemoteTrack: mockEnsureRemoteTrack },
}));
jest.mock("../../services/remoteTrackMetadataResolver", () => ({
    resolveRemoteTrackMetadataForRequest: mockResolveMetadata,
}));
jest.mock("../../utils/logger", () => {
    const logger = {
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);
    return { logger };
});
jest.mock("../../config", () => ({ config: { nodeEnv: "development" } }));
import { remoteTracksRouter } from "../library/remoteTracks";
import { errorHandler } from "../../middleware/errorHandler";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    const owner = req.get("x-fixture-owner");
    if (owner)
        (req as Request).user = {
            id: owner,
            username: "fixture",
            role: "user",
        };
    next();
});
app.use("/api/library", remoteTracksRouter);
app.use(errorHandler);
const pathFor = (id: string) =>
    `/api/library/remote-tracks/${encodeURIComponent(id)}/preference`;
function verified(provider: "vk" | "yandex", providerTrackId: string) {
    return {
        id: "verified-namespace",
        provider,
        providerTrackId,
        verifiedMetadata: {
            provider,
            id: providerTrackId,
            title: "Confirmed",
            artists: ["Artist", "Guest"],
            duration: 180,
            contentVersion: "clean",
            preview: false,
        },
        metadataObservedAt: new Date("2026-10-08T08:00:00Z"),
        metadataConnectionVersion: 7,
    };
}
describe("direct preference HTTP contract", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        mockPrisma.$transaction.mockImplementation(async (work: any) =>
            work(mockPrisma),
        );
        mockPrisma.remotePreferenceIntent.updateMany.mockResolvedValue({
            count: 1,
        });
        mockPrisma.remotePreferenceIntent.deleteMany.mockResolvedValue({
            count: 1,
        });
        mockPrisma.trackYtMusic.findUnique.mockResolvedValue(null);
        mockPrisma.likedRemoteTrack.findUnique.mockResolvedValue(null);
        mockPrisma.dislikedEntity.findUnique.mockResolvedValue(null);
    });
    it.each(["vk:-12_34", "yandex:123"])(
        "requires an authenticated owner for %s",
        async (id) => {
            expect((await request(app).get(pathFor(id))).status).toBe(401);
            expect(
                (
                    await request(app)
                        .post(pathFor(id))
                        .send({ signal: "thumbs_up" })
                ).status,
            ).toBe(401);
            expect(
                mockPrisma.trackMusicSource.findUnique,
            ).not.toHaveBeenCalled();
            expect(
                mockPrisma.remotePreferenceIntent.upsert,
            ).not.toHaveBeenCalled();
        },
    );
    it.each([
        ["vk", "-12_34"],
        ["yandex", "123"],
    ] as const)(
        "reads %s owner's exact historical preference without a live provider",
        async (provider, native) => {
            mockPrisma.trackMusicSource.findUnique.mockResolvedValue(
                verified(provider, native),
            );
            mockPrisma.likedRemoteTrack.findUnique.mockResolvedValue({
                likedAt: new Date("2026-10-08T08:00:00Z"),
            });
            const response = await request(app)
                .get(pathFor(`${provider}:${native}`))
                .set("x-fixture-owner", "owner-a");
            expect(response.status).toBe(200);
            expect(response.body.signal).toBe("thumbs_up");
            expect(mockPrisma.likedRemoteTrack.findUnique).toHaveBeenCalledWith(
                {
                    where: {
                        userId_trackMusicSourceId: {
                            userId: "owner-a",
                            trackMusicSourceId: "verified-namespace",
                        },
                    },
                    select: { likedAt: true },
                },
            );
            expect(mockResolveMetadata).not.toHaveBeenCalled();
        },
    );
    it.each([
        ["vk", "-12_34"],
        ["yandex", "123"],
    ] as const)(
        "likes %s using server facts and ignores body/owner metadata",
        async (provider, native) => {
            const row = verified(provider, native);
            mockPrisma.trackMusicSource.findUnique.mockResolvedValue(row);
            const response = await request(app)
                .post(pathFor(`${provider}:${native}`))
                .set("x-fixture-owner", "owner-a")
                .send({
                    signal: "thumbs_up",
                    userId: "owner-b",
                    metadata: {
                        title: "client-secret",
                        artist: "client-secret",
                        streamUrl: "https://example.invalid/client-secret",
                    },
                });
            expect(response.status).toBe(200);
            expect(response.body.signal).toBe("thumbs_up");
            expect(mockPrisma.likedRemoteTrack.upsert).toHaveBeenCalledWith({
                where: {
                    userId_trackMusicSourceId: {
                        userId: "owner-a",
                        trackMusicSourceId: row.id,
                    },
                },
                create: {
                    userId: "owner-a",
                    trackMusicSourceId: row.id,
                    likedAt: expect.any(Date),
                },
                update: { likedAt: expect.any(Date) },
            });
            expect(
                mockPrisma.remotePreferenceIntent.upsert.mock
                    .invocationCallOrder[0],
            ).toBeLessThan(
                mockPrisma.trackMusicSource.findUnique.mock
                    .invocationCallOrder[0],
            );
            expect(mockEnsureRemoteTrack).not.toHaveBeenCalled();
            expect(mockResolveMetadata).not.toHaveBeenCalled();
            expect(JSON.stringify(response.body)).not.toContain(
                "client-secret",
            );
        },
    );
    it.each([
        "missing",
        "unattested",
        "wrong-provider",
        "wrong-id",
        "invalid-observation",
    ])(
        "returns a static failure for %s namespace even with supplied client claims",
        async (scenario) => {
            const row = verified("vk", "-12_34");
            if (scenario === "unattested") row.verifiedMetadata = null as any;
            if (scenario === "wrong-provider") row.provider = "yandex";
            if (scenario === "wrong-id") row.providerTrackId = "-12_99";
            if (scenario === "invalid-observation")
                row.metadataObservedAt = new Date("invalid");
            mockPrisma.trackMusicSource.findUnique.mockResolvedValue(
                scenario === "missing" ? null : row,
            );
            const response = await request(app)
                .post(pathFor("vk:-12_34"))
                .set("x-fixture-owner", "owner-a")
                .send({
                    signal: "thumbs_up",
                    metadata: {
                        title: "client-secret",
                        artist: "client-secret",
                    },
                });
            expect(response.status).toBe(404);
            expect(response.body).toEqual({ error: "track_not_verified" });
            expect(mockPrisma.likedRemoteTrack.upsert).not.toHaveBeenCalled();
            expect(
                mockPrisma.remotePreferenceIntent.deleteMany,
            ).toHaveBeenCalledWith({
                where: {
                    userId: "owner-a",
                    remoteTrackId: "vk:-12_34",
                    token: expect.any(String),
                },
            });
            expect(mockEnsureRemoteTrack).not.toHaveBeenCalled();
            expect(mockResolveMetadata).not.toHaveBeenCalled();
        },
    );
    it.each(["thumbs_down", "clear"])(
        "permits %s when the exact namespace/provider is unavailable",
        async (signal) => {
            mockPrisma.trackMusicSource.findUnique.mockResolvedValue(null);
            const response = await request(app)
                .post(pathFor("yandex:123"))
                .set("x-fixture-owner", "owner-a")
                .send({ signal });
            expect(response.status).toBe(200);
            expect(response.body.signal).toBe(signal);
            expect(mockEnsureRemoteTrack).not.toHaveBeenCalled();
            expect(mockResolveMetadata).not.toHaveBeenCalled();
        },
    );
    it.each(["vk:bad", "vk:1_2 ", "yandex:1.2", "audius:abc"])(
        "rejects malformed/unsupported %s before reserving an intent",
        async (id) => {
            const response = await request(app)
                .post(pathFor(id))
                .set("x-fixture-owner", "owner-a")
                .send({ signal: "thumbs_up" });
            expect(response.status).toBe(400);
            expect(
                mockPrisma.remotePreferenceIntent.upsert,
            ).not.toHaveBeenCalled();
            expect(
                mockPrisma.trackMusicSource.findUnique,
            ).not.toHaveBeenCalled();
        },
    );
});
