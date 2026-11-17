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
    headers: Record<string, string>;
};

function createResponse(): JsonResponse {
    const response = {
        statusCode: 200,
        body: undefined as unknown,
        headers: {} as Record<string, string>,
        setHeader(name: string, value: string) {
            this.headers[name.toLowerCase()] = value;
            return this;
        },
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
    query?: Record<string, unknown>;
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
    jest.resetAllMocks();
});

interface SavedRow {
    id: string;
    userId: string;
    entityType: string;
    source: string;
    entityId: string;
    title: string;
    subtitle: string | null;
    imageUrl: string | null;
    createdAt: Date;
    updatedAt: Date;
}

interface SavedWhere {
    userId?: string;
    entityType?: string;
    OR?: Array<{
        title?: { contains: string; mode?: string };
        subtitle?: { contains: string; mode?: string };
    }>;
}

function savedRow(overrides: Partial<SavedRow>): SavedRow {
    return {
        id: "saved-1",
        userId: "owner-a",
        entityType: "album",
        source: "ytmusic",
        entityId: "MPREb_exact-provider-id",
        title: "Meteora",
        subtitle: null,
        imageUrl: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        ...overrides,
    };
}

/** Models PostgreSQL LIKE metacharacters at the Prisma boundary, not query construction. */
function matchesContains(
    value: string | null,
    filter: { contains: string; mode?: string },
): boolean {
    if (value === null) return false;
    let pattern = "";
    let escaped = false;
    for (const character of filter.contains) {
        if (!escaped && character === "\\") {
            escaped = true;
            continue;
        }
        if (!escaped && character === "%") pattern += ".*";
        else if (!escaped && character === "_") pattern += ".";
        else pattern += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        escaped = false;
    }
    return new RegExp(pattern, filter.mode === "insensitive" ? "iu" : "u").test(
        value,
    );
}

function useSavedCollection(rows: SavedRow[]): void {
    const matches = (row: SavedRow, where: SavedWhere) =>
        (!where.userId || row.userId === where.userId) &&
        (!where.entityType || row.entityType === where.entityType) &&
        (!where.OR ||
            where.OR.some(
                (branch) =>
                    (branch.title &&
                        matchesContains(row.title, branch.title)) ||
                    (branch.subtitle &&
                        matchesContains(row.subtitle, branch.subtitle)),
            ));
    savedMusicEntity.findMany.mockImplementation(
        async ({
            where,
            orderBy,
            skip,
            take,
        }: {
            where: SavedWhere;
            orderBy:
                | Record<string, "asc" | "desc">
                | Record<string, "asc" | "desc">[];
            skip: number;
            take: number;
        }) => {
            const ordering = Array.isArray(orderBy) ? orderBy : [orderBy];
            return rows
                .filter((row) => matches(row, where))
                .sort((left, right) => {
                    for (const clause of ordering) {
                        for (const [key, direction] of Object.entries(clause)) {
                            const a = left[key as "id" | "createdAt"];
                            const b = right[key as "id" | "createdAt"];
                            const comparison = a < b ? -1 : a > b ? 1 : 0;
                            if (comparison)
                                return direction === "asc"
                                    ? comparison
                                    : -comparison;
                        }
                    }
                    return 0;
                })
                .slice(skip, skip + take);
        },
    );
    savedMusicEntity.count.mockImplementation(
        async ({ where }: { where: SavedWhere }) =>
            rows.filter((row) => matches(row, where)).length,
    );
}

describe("saved collection search", () => {
    it("matches title or subtitle case-insensitively for the authenticated owner and requested type", async () => {
        const titleMatch = savedRow({
            id: "a-title",
            title: "METEORA",
            source: "discovery",
            entityId: "exact:A/1",
        });
        const subtitleMatch = savedRow({
            id: "a-subtitle",
            title: "Other album",
            subtitle: "Live Meteora",
        });
        const otherOwner = savedRow({
            id: "b-title",
            userId: "owner-b",
            title: "Meteora",
        });
        useSavedCollection([
            titleMatch,
            subtitleMatch,
            otherOwner,
            savedRow({
                id: "a-artist",
                entityType: "artist",
                title: "Meteora",
            }),
            savedRow({ id: "a-unrelated", title: "Unrelated" }),
        ]);

        for (const [userId, expected] of [
            ["owner-a", [subtitleMatch, titleMatch]],
            ["owner-b", [otherOwner]],
        ] as const) {
            const res = createResponse();
            await handleListSavedMusicEntities(
                request({
                    userId,
                    query: {
                        q: "  mEtEoRa  ",
                        type: "album",
                        userId: "owner-b",
                    },
                }),
                res,
            );
            expect(res.body).toEqual({
                items: expected,
                total: expected.length,
                search: { query: "mEtEoRa", offset: 0, limit: 80 },
            });
            expect(res.headers["cache-control"]).toBe("private, no-store");
        }
    });

    it.each([
        ["%", "100% music", "1000 music"],
        ["_", "under_score", "underXscore"],
        ["\\", "slash\\music", "slashmusic"],
    ])(
        "treats %j as a literal rather than a LIKE wildcard or escape",
        async (q, match, decoy) => {
            const item = savedRow({ title: match });
            useSavedCollection([item, savedRow({ id: "decoy", title: decoy })]);
            const res = createResponse();
            await handleListSavedMusicEntities(
                request({ userId: "owner-a", query: { q } }),
                res,
            );
            expect(res.body).toEqual({
                items: [item],
                total: 1,
                search: { query: q, offset: 0, limit: 80 },
            });
        },
    );

    it("paginates equal timestamps by id without duplicates and counts all matches", async () => {
        const a = savedRow({ id: "a" });
        const b = savedRow({ id: "b" });
        useSavedCollection([
            b,
            savedRow({ id: "older", createdAt: new Date("2025-01-01Z") }),
            a,
        ]);
        for (const [offset, expected] of [
            ["0", a],
            ["1", b],
        ] as const) {
            const res = createResponse();
            await handleListSavedMusicEntities(
                request({
                    userId: "owner-a",
                    query: { q: "meteora", limit: "1", offset },
                }),
                res,
            );
            expect(res.body).toEqual({
                items: [expected],
                total: 3,
                search: { query: "meteora", offset: Number(offset), limit: 1 },
            });
        }
    });

    it.each(["", " \t\n "])(
        "echoes a blank query while preserving the ordinary owner/type filter",
        async (q) => {
            const item = savedRow({ entityType: "artist", title: "Unrelated" });
            useSavedCollection([
                item,
                savedRow({ id: "album" }),
                savedRow({
                    id: "foreign",
                    userId: "owner-b",
                    entityType: "artist",
                }),
            ]);
            const res = createResponse();
            await handleListSavedMusicEntities(
                request({ userId: "owner-a", query: { q, type: "artist" } }),
                res,
            );
            expect(res.body).toEqual({
                items: [item],
                total: 1,
                search: { query: "", offset: 0, limit: 80 },
            });
        },
    );

    it.each([
        "x".repeat(501),
        ["album", "artist"],
        { nested: "album" },
        42,
        null,
        undefined,
    ])(
        "rejects invalid present q %j before accessing the database",
        async (q) => {
            const res = createResponse();
            await handleListSavedMusicEntities(
                request({ userId: "owner-a", query: { q } }),
                res,
            );
            expect(res.statusCode).toBe(400);
            expect(savedMusicEntity.findMany).not.toHaveBeenCalled();
            expect(savedMusicEntity.count).not.toHaveBeenCalled();
        },
    );

    it("accepts a trimmed 500-character query and echoes effective paging bounds", async () => {
        useSavedCollection([]);
        const res = createResponse();
        await handleListSavedMusicEntities(
            request({
                userId: "owner-a",
                query: {
                    q: `  ${"x".repeat(500)}  `,
                    limit: "999",
                    offset: "999999",
                },
            }),
            res,
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            items: [],
            total: 0,
            search: { query: "x".repeat(500), offset: 100000, limit: 200 },
        });
    });

    it("retains type validation and authentication for search requests", async () => {
        const invalidType = createResponse();
        await handleListSavedMusicEntities(
            request({
                userId: "owner-a",
                query: { q: "album", type: "podcast" },
            }),
            invalidType,
        );
        expect(invalidType.statusCode).toBe(400);
        const anonymous = createResponse();
        await handleListSavedMusicEntities(
            request({ query: { q: "album", userId: "owner-a" } }),
            anonymous,
        );
        expect(anonymous.statusCode).toBe(401);
        expect(savedMusicEntity.findMany).not.toHaveBeenCalled();
    });

    it("keeps the unfiltered list response and created-time ordering when q is absent", async () => {
        const b = savedRow({ id: "b", title: "Any album" });
        const a = savedRow({
            id: "a",
            entityType: "artist",
            title: "Any artist",
        });
        useSavedCollection([
            b,
            a,
            savedRow({ id: "foreign", userId: "owner-b" }),
        ]);
        const res = createResponse();
        await handleListSavedMusicEntities(request({ userId: "owner-a" }), res);
        expect(res.body).toEqual({ items: [b, a], total: 2 });
    });
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
