import type { Request, Response } from "express";

process.env.JWT_SECRET =
    process.env.JWT_SECRET || "recommendation-trace-route-test-secret";
process.env.SETTINGS_ENCRYPTION_KEY =
    process.env.SETTINGS_ENCRYPTION_KEY ||
    "recommendation-trace-route-test-pepper";

const mockGenerationFindFirst = jest.fn();
const mockUserFindUnique = jest.fn();
const mockApiKeyFindUnique = jest.fn();
const mockApiKeyUpdate = jest.fn().mockResolvedValue({});
jest.mock("../../utils/db", () => ({
    prisma: {
        recommendationGeneration: { findFirst: mockGenerationFindFirst },
        user: { findUnique: mockUserFindUnique },
        apiKey: { findUnique: mockApiKeyFindUnique, update: mockApiKeyUpdate },
    },
}));
jest.mock("../../utils/redis", () => ({ redisClient: {} }));
jest.mock("../../workers/queues", () => ({ schedulerMaintenanceQueue: {} }));
jest.mock("../adminLibraryHealthPurge", () => ({
    handlePurgeRemovedStatus: jest.fn(),
    handlePurgeRemovedTracksNow: jest.fn(),
}));
jest.mock("../../config", () => ({
    config: { workers: { trackRemovalRetentionDays: 90 } },
}));

import router from "../admin";
import { generateToken } from "../../middleware/auth";
import { buildRecommendationGenerationTrace } from "../../services/recommendations/generationTrace";
import type {
    ScoredRecommendation,
    RecommendationCandidate,
} from "../../services/recommendations/types";

const now = new Date("2026-11-17T12:00:00.000Z");
const query = { userId: "target-owner", generationId: "generation-1" };
type Exposure = {
    userId: string;
    generationId: string;
    position: number;
    provider: string;
    providerTrackId: string;
    score: number | null;
};

function exposure(
    provider = "youtube",
    providerTrackId = "video_1",
    position = 0,
): Exposure {
    return {
        ...query,
        userId: query.userId,
        generationId: query.generationId,
        position,
        provider,
        providerTrackId,
        score: 1,
    };
}

function storedGeneration(exposures: Exposure[] = [exposure()]) {
    const rows: ScoredRecommendation[] = exposures
        .slice(0, 75)
        .map((entry, index) => ({
            track: {
                id: `private-${index}`,
                canonicalKey: `private-key-${index}`,
                title: "private title",
                duration: 180,
                artist: { id: null, name: `Artist ${index}` },
                album: {
                    id: null,
                    title: "private album",
                    coverArt: "https://private.invalid/token",
                },
                source: ([
                    "youtube",
                    "tidal",
                    "library",
                    "vk",
                    "yandex",
                ].includes(entry.provider)
                    ? entry.provider
                    : "youtube") as RecommendationCandidate["source"],
                streamSource: "youtube",
                provider: { youtubeVideoId: "video", tidalTrackId: null },
                candidateSources: ["private source"],
                providerPrior: 1,
            },
            score: 1,
        }));
    const loadedSources = {
        youtube: 0,
        tidal: 0,
        library: 0,
        vk: 0,
        yandex: 0,
    };
    rows.forEach(({ track }) => loadedSources[track.source]++);
    const trace = buildRecommendationGenerationTrace({
        algorithm: "hybrid-v2",
        mode: "active",
        served: true,
        requestedCount: rows.length,
        ranked: rows,
        finalized: rows,
        spacingApplied: false,
        coverage: {
            loadedCount: rows.length,
            sanitizedCount: rows.length,
            canonicalIdPresentCount: 0,
            embeddingPresentCount: 0,
            admittedCount: rows.length,
            rankInputCount: rows.length,
            loadedSources,
        },
        filters: {
            invalidNative: 0,
            contentExcluded: 0,
            moodExcluded: 0,
            disliked: 0,
            feedbackUnavailable: 0,
        },
    });
    if (!trace) throw new Error("Trace fixture rejected by actual builder");
    return {
        id: query.generationId,
        userId: query.userId,
        createdAt: now,
        surface: "wave",
        algorithm: "hybrid-v2",
        served: true,
        context: {
            recommendationTrace: trace,
            privateHistory: ["raw private history"],
            accessToken: "raw-secret-token",
            mediaUrl: "https://private.invalid/media",
        },
        exposures,
    };
}

function token(id = "admin-1") {
    return generateToken({ id, username: id, role: "admin", tokenVersion: 1 });
}

async function request(
    input: {
        query?: Record<string, unknown>;
        headers?: Record<string, string>;
        anonymous?: boolean;
    } = {},
) {
    let finish: () => void = () => {};
    const headers: Record<string, string> = {};
    const res: any = {
        statusCode: 200,
        body: undefined,
        setHeader(name: string, value: string) {
            headers[name.toLowerCase()] = value;
            return res;
        },
        getHeader(name: string) {
            return headers[name.toLowerCase()];
        },
        vary(name: string) {
            headers.vary = headers.vary ? `${headers.vary}, ${name}` : name;
            return res;
        },
        status(code: number) {
            res.statusCode = code;
            return res;
        },
        json(body: unknown) {
            res.body = body;
            finish();
            return res;
        },
    };
    const req = {
        method: "GET",
        url: "/recommendation-trace",
        originalUrl: "/api/admin/recommendation-trace",
        headers: {
            ...(input.anonymous ? {} : { authorization: `Bearer ${token()}` }),
            ...input.headers,
        },
        query: input.query ?? query,
    } as unknown as Request;
    await new Promise<void>((resolve, reject) => {
        finish = resolve;
        (router as any).handle(req, res as Response, (error?: unknown) =>
            error ? reject(error) : resolve(),
        );
    });
    return { status: res.statusCode, body: res.body, headers };
}

describe("admin recommendation trace reader", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGenerationFindFirst.mockResolvedValue(storedGeneration());
        mockUserFindUnique.mockImplementation(
            async ({ where }: { where: { id: string } }) => ({
                id: where.id,
                username: where.id,
                role: where.id === "member-1" ? "user" : "admin",
                tokenVersion: 1,
            }),
        );
        mockApiKeyFindUnique.mockResolvedValue({
            id: "api-key-1",
            createdAt: new Date(),
            user: { id: "admin-1", username: "admin", role: "admin" },
        });
    });

    it("enforces the registered real auth/admin/interactive middleware before reading generations", async () => {
        expect((await request({ anonymous: true })).status).toBe(401);
        const normalUser = await request({
            headers: { authorization: `Bearer ${token("member-1")}` },
        });
        expect(normalUser.status).toBe(403);
        const apiKey = await request({
            headers: { "x-api-key": "synthetic-admin-key" },
        });
        expect(apiKey.status).toBe(403);
        expect(apiKey.body).toEqual({
            error: "Interactive session authentication required",
        });
        expect(mockGenerationFindFirst).not.toHaveBeenCalled();
    });

    it.each([
        null,
        { ...storedGeneration(), userId: "foreign-owner" },
        { ...storedGeneration(), id: "foreign-generation" },
        { ...storedGeneration(), userId: undefined },
    ])(
        "returns the same 404 for missing or mismatched ownership",
        async (stored) => {
            mockGenerationFindFirst.mockResolvedValue(stored);
            const result = await request();
            expect(result.status).toBe(404);
            expect(result.body).toEqual({
                error: "Recommendation generation not found",
            });
            expect(mockGenerationFindFirst).toHaveBeenCalledTimes(1);
            expect(mockGenerationFindFirst.mock.calls[0][0].where).toEqual({
                id: query.generationId,
                userId: query.userId,
            });
        },
    );

    it("returns one bounded safe projection and sanitizes references for all five sources", async () => {
        const references = [
            ["youtube", "video_-123"],
            ["library", "cLocal_123"],
            ["tidal", "123456"],
            ["vk", "vk:-123_456"],
            ["yandex", "yandex:123:456"],
            ["youtube", "https://private.invalid/media?token=secret"],
            ["library", "/music/private.flac"],
            ["tidal", "123?token=secret"],
            ["vk", "-1_2_accesskey"],
            ["yandex", "https://private.invalid/token"],
            ["raw-provider-secret", "raw-track-secret"],
        ];
        const exposures = references.map(([provider, id], position) =>
            exposure(provider, id, position),
        );
        exposures[5].score = Infinity;
        const stored = storedGeneration(exposures);
        mockGenerationFindFirst.mockResolvedValue(stored);
        const result = await request();
        expect(result.status).toBe(200);
        expect(result.headers["cache-control"]).toBe("private, no-store");
        expect(result.headers.vary).toContain("Authorization");
        expect(result.body).toMatchObject({
            available: true,
            generationId: query.generationId,
            createdAt: now.toISOString(),
            surface: "wave",
            algorithm: "hybrid-v2",
            served: true,
            trace: stored.context.recommendationTrace,
        });
        expect(
            result.body.exposures.map(
                (row: { providerTrackId: string | null }) =>
                    row.providerTrackId,
            ),
        ).toEqual([
            ...references.slice(0, 5).map(([, id]) => id),
            ...Array(6).fill(null),
        ]);
        expect(result.body.exposures[5].score).toBeNull();
        expect(result.body.exposures[10].source).toBeNull();
        const encoded = JSON.stringify(result.body);
        expect(encoded).not.toMatch(
            /private|raw-secret|accesskey|raw-provider|raw-track|token=|https:|\"context\"|\"embedding\"/,
        );
        const lookup = mockGenerationFindFirst.mock.calls[0][0];
        expect(lookup.select.exposures).toMatchObject({
            where: { userId: query.userId, generationId: query.generationId },
            take: 75,
            orderBy: [{ position: "asc" }, { id: "asc" }],
        });
        expect(lookup.select.exposures.select).toEqual({
            userId: true,
            generationId: true,
            position: true,
            provider: true,
            providerTrackId: true,
            score: true,
        });
    });

    it.each([
        null,
        {},
        { recommendationTrace: { version: 999, rawToken: "secret" } },
        {
            recommendationTrace: {
                ...storedGeneration().context.recommendationTrace,
                privateHistory: ["secret"],
            },
        },
    ])(
        "marks legacy, unknown or corrupt traces unavailable without revealing raw context",
        async (context) => {
            mockGenerationFindFirst.mockResolvedValue({
                ...storedGeneration(),
                context,
            });
            const result = await request();
            expect(result.status).toBe(200);
            expect(result.body).toEqual({
                available: false,
                generationId: query.generationId,
            });
        },
    );

    it("does not expose a valid trace under mismatched persisted algorithm or delivery metadata", async () => {
        mockGenerationFindFirst.mockResolvedValue({
            ...storedGeneration(),
            served: false,
        });
        expect((await request()).body).toEqual({
            available: false,
            generationId: query.generationId,
        });
    });

    it("caps exposures at 75 and drops any unscoped related rows", async () => {
        const exposures = Array.from({ length: 80 }, (_, index) =>
            exposure("youtube", `video-${index}`, index),
        );
        const stored = storedGeneration(exposures);
        mockGenerationFindFirst.mockResolvedValue(stored);
        const result = await request();
        expect(result.body.exposures).toHaveLength(75);
        expect(result.body.exposures.at(-1).position).toBe(74);
        mockGenerationFindFirst.mockResolvedValue({
            ...stored,
            exposures: [
                exposure(),
                {
                    ...exposure("youtube", "foreign-track", 1),
                    userId: "foreign-owner",
                },
            ],
        });
        const scoped = await request();
        expect(scoped.body.exposures).toHaveLength(1);
        expect(JSON.stringify(scoped.body)).not.toContain("foreign-track");
    });

    it.each([
        { userId: "target-owner" },
        { ...query, userId: ["target-owner"] },
        { ...query, generationId: "g".repeat(129) },
        { ...query, userId: "owner/foreign" },
        { ...query, userId: "владелец" },
        { ...query, token: "secret" },
    ])(
        "rejects malformed or extra query parameters before the generation lookup",
        async (params) => {
            const result = await request({ query: params });
            expect(result.status).toBe(400);
            expect(mockGenerationFindFirst).not.toHaveBeenCalled();
            expect(result.body).toEqual({
                error: "Invalid recommendation trace query",
            });
        },
    );

    it("keeps unexpected storage errors out of the response", async () => {
        mockGenerationFindFirst.mockRejectedValue(
            new Error("raw database secret-token"),
        );
        const result = await request();
        expect(result.status).toBe(500);
        expect(result.body).toEqual({
            error: "Failed to read recommendation trace",
        });
    });
});
