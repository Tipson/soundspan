import type { Request, Response } from "express";

const savedMusicEntity = {
    findMany: jest.fn(),
    count: jest.fn(),
    findUnique: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
};

jest.mock("../../utils/db", () => ({
    prisma: { savedMusicEntity },
}));

import {
    handleDeleteSavedMusicEntity,
    handleGetSavedMusicEntityStatus,
    handleListSavedMusicEntities,
    handlePutSavedMusicEntity,
} from "../library/savedMusicEntities";

type JsonResponse = Response & {
    statusCode: number;
    body?: unknown;
};

function createResponse(): JsonResponse {
    const response = {
        statusCode: 200,
        body: undefined as unknown,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(body: unknown) {
            this.body = body;
            return this;
        },
    };
    return response as unknown as JsonResponse;
}

function request(input: {
    userId?: string;
    query?: Record<string, string>;
    body?: unknown;
}): Request {
    return {
        user: input.userId
            ? { id: input.userId, username: "tester", role: "user" }
            : undefined,
        query: input.query ?? {},
        body: Object.hasOwn(input, "body") ? input.body : {},
    } as unknown as Request;
}

beforeEach(() => {
    jest.clearAllMocks();
});

it("lists only the signed-in user's saved albums with bounded pagination", async () => {
    savedMusicEntity.findMany.mockResolvedValue([{ id: "saved-1" }]);
    savedMusicEntity.count.mockResolvedValue(1);
    const res = createResponse();

    await handleListSavedMusicEntities(
        request({
            userId: "user-1",
            query: { type: "album", limit: "9999", offset: "2" },
        }),
        res,
    );

    expect(savedMusicEntity.findMany).toHaveBeenCalledWith({
        where: { userId: "user-1", entityType: "album" },
        orderBy: { createdAt: "desc" },
        skip: 2,
        take: 200,
    });
    expect(res.body).toEqual({ items: [{ id: "saved-1" }], total: 1 });
});

it("upserts a validated entity by owner, type, source, and provider id", async () => {
    savedMusicEntity.upsert.mockResolvedValue({ id: "saved-1" });
    const res = createResponse();

    await handlePutSavedMusicEntity(
        request({
            userId: "user-1",
            body: {
                type: "album",
                source: "ytmusic",
                entityId: "MPREb_example",
                title: "  Meteora  ",
                subtitle: "Linkin Park",
                imageUrl: "https://example.test/cover.jpg",
            },
        }),
        res,
    );

    expect(savedMusicEntity.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
            where: {
                userId_entityType_source_entityId: {
                    userId: "user-1",
                    entityType: "album",
                    source: "ytmusic",
                    entityId: "MPREb_example",
                },
            },
            create: expect.objectContaining({
                userId: "user-1",
                entityType: "album",
                title: "Meteora",
            }),
        }),
    );
    expect(res.body).toEqual({ item: { id: "saved-1" }, saved: true });
});

it("rejects malformed or unsupported save payloads before database access", async () => {
    const res = createResponse();

    await handlePutSavedMusicEntity(
        request({
            userId: "user-1",
            body: {
                type: "podcast",
                source: "ytmusic",
                entityId: "id",
                title: "Title",
            },
        }),
        res,
    );

    expect(res.statusCode).toBe(400);
    expect(savedMusicEntity.upsert).not.toHaveBeenCalled();
});

it("rejects a non-object JSON body instead of throwing a route-level error", async () => {
    const res = createResponse();

    await handlePutSavedMusicEntity(
        request({ userId: "user-1", body: null }),
        res,
    );

    expect(res.statusCode).toBe(400);
    expect(savedMusicEntity.upsert).not.toHaveBeenCalled();
});

it("rejects active-content image URLs in saved metadata", async () => {
    const res = createResponse();

    await handlePutSavedMusicEntity(
        request({
            userId: "user-1",
            body: {
                type: "album",
                source: "ytmusic",
                entityId: "album-1",
                title: "Album",
                imageUrl: "javascript:alert(1)",
            },
        }),
        res,
    );

    expect(res.statusCode).toBe(400);
    expect(savedMusicEntity.upsert).not.toHaveBeenCalled();
});

it("reads and removes one exact device-independent account save", async () => {
    savedMusicEntity.findUnique.mockResolvedValue({ id: "saved-1" });
    savedMusicEntity.deleteMany.mockResolvedValue({ count: 1 });

    const statusRes = createResponse();
    await handleGetSavedMusicEntityStatus(
        request({
            userId: "user-1",
            query: {
                type: "artist",
                source: "ytmusic",
                entityId: "UC123",
            },
        }),
        statusRes,
    );
    expect(statusRes.body).toEqual({
        saved: true,
        item: { id: "saved-1" },
    });

    const deleteRes = createResponse();
    await handleDeleteSavedMusicEntity(
        request({
            userId: "user-1",
            body: {
                type: "artist",
                source: "ytmusic",
                entityId: "UC123",
            },
        }),
        deleteRes,
    );
    expect(savedMusicEntity.deleteMany).toHaveBeenCalledWith({
        where: {
            userId: "user-1",
            entityType: "artist",
            source: "ytmusic",
            entityId: "UC123",
        },
    });
    expect(deleteRes.body).toEqual({ saved: false, removed: true });
});

it("requires an authenticated owner even when called outside the router", async () => {
    const res = createResponse();
    await handleListSavedMusicEntities(request({}), res);
    expect(res.statusCode).toBe(401);
    expect(savedMusicEntity.findMany).not.toHaveBeenCalled();
});
