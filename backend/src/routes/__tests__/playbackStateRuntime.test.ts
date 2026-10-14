import express from "express";
import request from "supertest";

jest.mock("../../middleware/rateLimitStore", () => {
    const { MemoryStore } = jest.requireActual("express-rate-limit");
    return {
        createRedisRateLimitOptions: () => ({
            store: new MemoryStore(),
            passOnStoreError: true,
        }),
    };
});

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: () => void) => {
        req.user ??= { id: "u1" };
        next();
    },
}));

const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: (...args: unknown[]) => mockLoggerWarn(...args),
        error: (...args: unknown[]) => mockLoggerError(...args),
        child: () => ({
            warn: (...args: unknown[]) => mockLoggerWarn(...args),
            error: (...args: unknown[]) => mockLoggerError(...args),
        }),
    },
}));

const prisma = {
    playbackState: {
        findUnique: jest.fn(),
    },
};

const Prisma = {
    DbNull: { __dbNull: true },
};

jest.mock("../../utils/db", () => ({
    prisma,
    Prisma,
}));

const mockSave = jest.fn();
jest.mock("../../services/playbackStateStore", () => ({
    ...jest.requireActual("../../services/playbackStateStore"),
    compareAndSetPlaybackState: async (args: unknown) => {
        const state = await mockSave(args);
        return {
            ...state,
            revision: state?.revision ?? "11111111-1111-4111-8111-111111111111",
        };
    },
}));

import router from "../playbackState";
import { requireAuth } from "../../middleware/auth";
import { playbackStateLimiter } from "../../middleware/rateLimiter";
import { prisma as prismaClient, Prisma as PrismaClient } from "../../utils/db";

const mockFindUnique = prismaClient.playbackState.findUnique as jest.Mock;

function getHandler(method: "get" | "post" | "delete", path: string) {
    const handlers = getRouteHandlers(method, path);
    const handler = handlers[handlers.length - 1];
    return (req: any, res: any) => {
        const header = req.header;
        req.header = (name: string) =>
            name === "If-Match" ? '"ps1.absent"' : header(name);
        return handler(req, res);
    };
}

function getRouteHandlers(method: "get" | "post" | "delete", path: string) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );

    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }

    return layer.route.stack.map((entry: any) => entry.handle);
}

function createRuntimeApp() {
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    app.use((req, _res, next) => {
        req.headers["if-match"] ??= '"ps1.absent"';
        next();
    });
    app.use("/", router);
    return app;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        set: jest.fn().mockReturnThis(),
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };

    return res;
}

describe("playbackState routes runtime", () => {
    const getState = getHandler("get", "/");
    const postState = getHandler("post", "/");
    const deleteState = getHandler("delete", "/");

    beforeEach(() => {
        jest.clearAllMocks();
        mockFindUnique.mockReset();
        mockSave.mockReset();
    });

    it.each(["vk", "yandex"])(
        "round-trips public %s recording metadata for exact queue restoration",
        async (provider) => {
            let stored: unknown;
            mockSave.mockImplementation(async ({ create }) => {
                stored = structuredClone(create);
                return stored;
            });
            mockFindUnique.mockImplementation(async () => stored);
            const id =
                provider === "vk"
                    ? "-12345678901234567890_12345678901234567890"
                    : "12345678901234567890";
            const recording = {
                provider,
                id,
                title: "Exact Song",
                artists: ["First Artist", "Second Artist"],
                duration: 180.5,
                contentVersion: "explicit",
                preview: false,
                isrc: "USABC1234567",
            };
            const current = {
                id: `${provider}:${id}`,
                title: recording.title,
                artist: { name: recording.artists.join(", ") },
                duration: recording.duration,
                streamSource: provider,
                mediaSource: provider,
                provider: { source: provider, providerTrackId: id },
                musicSourceRecording: {
                    ...recording,
                    token: "synthetic-private-token",
                    url: "https://private.example/signed",
                    nested: { secret: "private" },
                },
            };
            const app = createRuntimeApp();
            const saved = await request(app)
                .post("/")
                .set("X-Playback-Device-Id", "direct-device")
                .send({
                    playbackType: "track",
                    trackId: current.id,
                    queue: [
                        {
                            ...current,
                            musicSourceRecording: {
                                ...current.musicSourceRecording,
                                contentVersion: "clean",
                            },
                        },
                        current,
                    ],
                    currentIndex: 1,
                    currentTime: 73,
                    isShuffle: true,
                    isPlaying: false,
                });
            expect(saved.status).toBe(200);
            const restored = await request(app)
                .get("/")
                .set("X-Playback-Device-Id", "direct-device");
            expect(restored.status).toBe(200);
            expect(restored.body.queue[1].musicSourceRecording).toEqual(
                recording,
            );
            expect(
                restored.body.queue[0].musicSourceRecording.contentVersion,
            ).toBe("clean");
            expect(restored.body).toMatchObject({
                trackId: current.id,
                currentIndex: 1,
                currentTime: 73,
                isShuffle: true,
                isPlaying: false,
            });
            expect(JSON.stringify(restored.body)).not.toMatch(
                /private|signed|secret|token/,
            );
        },
    );

    it("discards invalid or mismatched direct recording metadata without dropping queue occurrences", async () => {
        const recording = {
            provider: "vk",
            id: "-12_34",
            title: "Song",
            artists: ["Artist"],
            duration: 180,
            contentVersion: "unknown",
            preview: false,
        };
        const track = {
            id: "vk:-12_34",
            mediaSource: "vk",
            streamSource: "vk",
            provider: { source: "vk", providerTrackId: "-12_34" },
            musicSourceRecording: recording,
        };
        const invalid = [
            { ...track, musicSourceRecording: undefined },
            {
                ...track,
                musicSourceRecording: {
                    ...recording,
                    provider: "yandex",
                    id: "34",
                },
            },
            { ...track, musicSourceRecording: { ...recording, id: "-12_35" } },
            { ...track, id: "vk:-12_35" },
            { ...track, provider: { source: "vk", providerTrackId: "-12_35" } },
            {
                ...track,
                provider: { source: "yandex", providerTrackId: "-12_34" },
            },
            { ...track, streamSource: "yandex" },
            { ...track, mediaSource: "local", streamSource: "local" },
            {
                ...track,
                musicSourceRecording: {
                    ...recording,
                    id: "http://private.example",
                },
            },
            {
                ...track,
                musicSourceRecording: { ...recording, title: "x".repeat(201) },
            },
            {
                ...track,
                musicSourceRecording: {
                    ...recording,
                    artists: ["x".repeat(101)],
                },
            },
            {
                ...track,
                musicSourceRecording: {
                    ...recording,
                    artists: Array(11).fill("Artist"),
                },
            },
            {
                ...track,
                musicSourceRecording: { ...recording, duration: 3601 },
            },
            { ...track, musicSourceRecording: { ...recording, preview: true } },
            {
                ...track,
                musicSourceRecording: {
                    ...recording,
                    contentVersion: "secret",
                },
            },
            {
                ...track,
                musicSourceRecording: { ...recording, isrc: "invalid" },
            },
        ];
        mockSave.mockImplementation(async ({ create }) =>
            structuredClone(create),
        );
        const res = createRes();
        await postState(
            {
                user: { id: "u1" },
                header: () => "device",
                body: {
                    playbackType: "track",
                    queue: invalid,
                    currentIndex: invalid.length - 1,
                    currentTime: 73,
                },
            },
            res,
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.queue).toHaveLength(invalid.length);
        expect(res.body.currentIndex).toBe(invalid.length - 1);
        expect(
            res.body.queue.every(
                (item: any) => item.musicSourceRecording === undefined,
            ),
        ).toBe(true);
    });

    it("round-trips original radio intent without storing credentials or arbitrary fields", async () => {
        let stored: unknown = null;
        mockSave.mockImplementation(async ({ create }) => {
            stored = structuredClone(create);
            return stored;
        });
        mockFindUnique.mockImplementation(async () => stored);
        const origins = [
            { kind: "track", source: "youtube", id: "seedVideo01" },
            { kind: "track", source: "library", id: "local-seed" },
            { kind: "artist", source: "library", id: "artist-seed" },
            { kind: "artist", source: "discovery", name: "Original Artist" },
        ];
        const app = createRuntimeApp();
        await request(app)
            .post("/")
            .set("X-Forwarded-For", "198.51.100.70")
            .send({
                playbackType: "track",
                trackId: "next",
                currentIndex: 1,
                currentTime: 73,
                isPlaying: false,
                queue: origins.map((origin, i) => ({
                    id: `next-${i}`,
                    radioOrigin: {
                        ...origin,
                        credential: "never persist",
                        signedUrl: "https://invalid/signed",
                    },
                })),
            })
            .expect(200);
        const restored = await request(app)
            .get("/")
            .set("X-Forwarded-For", "198.51.100.70")
            .expect(200);
        expect(
            restored.body.queue.map(
                (t: { radioOrigin: unknown }) => t.radioOrigin,
            ),
        ).toEqual(origins);
        expect(restored.body.currentTime).toBe(73);
        expect(restored.body.isPlaying).toBe(false);
    });

    it("discards malformed radio origin while preserving the playable queue item", async () => {
        mockSave.mockImplementation(async ({ create }) => create);
        const invalid = [
            null,
            "radio",
            { kind: "track", source: "youtube", id: "https://invalid/seed" },
            { kind: "artist", source: "discovery", name: "x".repeat(201) },
            { kind: "artist", source: "library", id: "x".repeat(129) },
        ];
        const response = await request(createRuntimeApp())
            .post("/")
            .set("X-Forwarded-For", "198.51.100.71")
            .send({
                playbackType: "track",
                queue: invalid.map((radioOrigin, i) => ({
                    id: `t-${i}`,
                    radioOrigin,
                })),
            })
            .expect(200);
        expect(response.body.queue).toHaveLength(invalid.length);
        for (const track of response.body.queue)
            expect(track).not.toHaveProperty("radioOrigin");
    });

    it("round-trips attribution and finite mode on every daily mix queue entry", async () => {
        let stored: unknown = null;
        mockSave.mockImplementation(async ({ create }) => {
            stored = structuredClone(create);
            return stored;
        });
        mockFindUnique.mockImplementation(async () => stored);
        const app = createRuntimeApp();
        const queue = Array.from({ length: 40 }, (_, i) => ({
            id: `yt:daily-${i}`,
            youtubeVideoId: `daily-${i}`,
            streamSource: "youtube",
            title: `Song ${i}`,
            duration: 180,
            recommendationGenerationId: " daily-generation ",
            recommendationSessionId: " client-session ",
            recommendationQueueMode: "finite",
            arbitraryExtra: "strip me",
        }));
        await request(app)
            .post("/")
            .set("X-Forwarded-For", "198.51.100.30")
            .set("X-Playback-Device-Id", "daily-device")
            .send({ playbackType: "track", trackId: queue[0].id, queue })
            .expect(200);
        const restored = await request(app)
            .get("/")
            .set("X-Forwarded-For", "198.51.100.30")
            .set("X-Playback-Device-Id", "daily-device")
            .expect(200);
        expect(restored.body.userId).toBe("u1");
        expect(restored.body.queue).toHaveLength(40);
        expect(
            restored.body.queue.map(
                (t: { youtubeVideoId: string }) => t.youtubeVideoId,
            ),
        ).toEqual(queue.map((t) => t.youtubeVideoId));
        for (const track of restored.body.queue) {
            expect(track.recommendationGenerationId).toBe("daily-generation");
            expect(track.recommendationSessionId).toBe("client-session");
            expect(track.recommendationQueueMode).toBe("finite");
            expect(track).not.toHaveProperty("arbitraryExtra");
        }
    });

    it("bounds queue attribution strings and rejects malformed lineage and queue modes", async () => {
        mockSave.mockImplementation(async ({ create }) => create);
        const response = await request(createRuntimeApp())
            .post("/")
            .set("X-Forwarded-For", "198.51.100.31")
            .send({
                playbackType: "track",
                queue: [
                    {
                        id: "valid",
                        recommendationGenerationId: "g".repeat(200),
                        recommendationSessionId: "s".repeat(200),
                    },
                    {
                        id: "invalid",
                        recommendationGenerationId: { arbitrary: true },
                        recommendationSessionId: ["session"],
                        recommendationQueueMode: "wave",
                    },
                    {
                        id: "empty",
                        recommendationGenerationId: "  ",
                        recommendationSessionId: 1,
                        recommendationQueueMode: { finite: true },
                    },
                ],
            })
            .expect(200);
        expect(response.body.queue[0].recommendationGenerationId).toHaveLength(
            128,
        );
        expect(response.body.queue[0].recommendationSessionId).toHaveLength(
            128,
        );
        for (const track of response.body.queue.slice(1)) {
            expect(track).not.toHaveProperty("recommendationGenerationId");
            expect(track).not.toHaveProperty("recommendationSessionId");
            expect(track).not.toHaveProperty("recommendationQueueMode");
        }
    });

    it("attaches the playback-state limiter before auth on every route", () => {
        for (const method of ["get", "post", "delete"] as const) {
            const handlers = getRouteHandlers(method, "/");
            expect(handlers).toHaveLength(3);
            expect(handlers[0]).toBe(playbackStateLimiter);
            expect(handlers[1]).toBe(requireAuth);
        }
    });

    it("allows the normal four playback-state updates per minute", async () => {
        mockSave.mockResolvedValue({ id: "state-normal-cadence" });
        const app = createRuntimeApp();
        const statuses: number[] = [];

        for (let update = 0; update < 4; update += 1) {
            const response = await request(app)
                .post("/")
                .set("X-Forwarded-For", "198.51.100.10")
                .send({
                    playbackType: "track",
                    trackId: "track-1",
                    currentTime: update * 15,
                });
            statuses.push(response.status);
        }

        expect(statuses).toEqual([200, 200, 200, 200]);
        expect(mockSave).toHaveBeenCalledTimes(4);
    });

    it("returns 429 at the finite playback-state request boundary", async () => {
        mockFindUnique.mockResolvedValue({ id: "state-rate-boundary" });
        const app = createRuntimeApp();

        for (let requestCount = 1; requestCount <= 600; requestCount += 1) {
            const response = await request(app)
                .get("/")
                .set("X-Forwarded-For", "198.51.100.11");
            expect(response.status).toBe(200);
        }

        const limitedResponse = await request(app)
            .get("/")
            .set("X-Forwarded-For", "198.51.100.11");

        expect(limitedResponse.status).toBe(429);
        expect(mockFindUnique).toHaveBeenCalledTimes(600);
    }, 30_000);

    it("gets state for a device-specific record", async () => {
        mockFindUnique.mockResolvedValueOnce({
            id: "state-1",
            userId: "u1",
            deviceId: "device-A",
            playbackType: "track",
        });

        const req = {
            user: { id: "u1" },
            header: (name: string) =>
                name === "X-Playback-Device-Id" ? "  device-A  " : undefined,
        } as any;
        const res = createRes();

        await getState(req, res);

        expect(mockFindUnique).toHaveBeenCalledWith({
            where: { userId_deviceId: { userId: "u1", deviceId: "device-A" } },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "state-1",
                playbackType: "track",
            }),
        );
    });

    it("reads legacy fallback without writing it for non-legacy devices", async () => {
        const legacyState = {
            id: "legacy-state",
            userId: "u1",
            deviceId: "legacy",
            playbackType: "podcast",
            trackId: null,
            audiobookId: null,
            podcastId: "pod-1",
            queue: null,
            currentIndex: 1,
            isShuffle: false,
            isPlaying: false,
            currentTime: 45,
        };

        mockFindUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(legacyState);

        const req = {
            user: { id: "u1" },
            header: () => "mobile",
        } as any;
        const res = createRes();

        await getState(req, res);

        expect(mockFindUnique).toHaveBeenNthCalledWith(1, {
            where: { userId_deviceId: { userId: "u1", deviceId: "mobile" } },
        });
        expect(mockFindUnique).toHaveBeenNthCalledWith(2, {
            where: { userId_deviceId: { userId: "u1", deviceId: "legacy" } },
        });
        expect(mockSave).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe(legacyState);
    });

    it("returns null when neither device nor legacy state exists", async () => {
        mockFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

        const req = {
            user: { id: "u1" },
            header: () => "",
        } as any;
        const res = createRes();

        await getState(req, res);

        expect(mockFindUnique).toHaveBeenCalledTimes(1);
        expect(mockSave).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toBeNull();
    });

    it("returns 500 when get state fails", async () => {
        mockFindUnique.mockRejectedValueOnce(new Error("db down"));

        const req = {
            user: { id: "u1" },
            header: () => "device-1",
        } as any;
        const res = createRes();

        await getState(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get playback state" });
    });

    it("validates playbackType and rejects invalid values", async () => {
        const missingReq = {
            user: { id: "u1" },
            header: () => "d1",
            body: {},
        } as any;
        const missingRes = createRes();
        await postState(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(400);
        expect(missingRes.body).toEqual({ error: "playbackType is required" });

        const invalidReq = {
            user: { id: "u1" },
            header: () => "d1",
            body: { playbackType: "video" },
        } as any;
        const invalidRes = createRes();
        await postState(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({ error: "Invalid playbackType" });
        expect(mockLoggerWarn).toHaveBeenCalledWith("Invalid playbackType", {
            playbackType: "video",
        });
    });

    it("preserves only the explicit device-only source policy in saved track queues", async () => {
        mockSave.mockResolvedValueOnce({ id: "state-policy" });
        const req = {
            user: { id: "u1" },
            header: () => "device-a",
            body: {
                playbackType: "track",
                trackId: "t1",
                queue: [
                    { id: "t1", playbackSourcePolicy: "device-only" },
                    { id: "t2", playbackSourcePolicy: { arbitrary: true } },
                ],
            },
        } as any;
        await postState(req, createRes());
        const saved = mockSave.mock.calls[0][0];
        expect(saved.update.queue[0].playbackSourcePolicy).toBe("device-only");
        expect(saved.create.queue[0].playbackSourcePolicy).toBe("device-only");
        expect(saved.update.queue[1]).not.toHaveProperty(
            "playbackSourcePolicy",
        );
    });

    it("sanitizes queue payload and persists bounded values", async () => {
        mockSave.mockResolvedValueOnce({
            id: "state-2",
            userId: "u1",
            deviceId: "legacy",
            playbackType: "track",
        });

        const req = {
            user: { id: "u1" },
            header: () => "   ",
            body: {
                playbackType: "track",
                trackId: "track-1",
                queue: [
                    {
                        id: "t1",
                        title: "First Track",
                        duration: "215",
                        streamSource: "youtube",
                        youtubeVideoId: "yt-123",
                        artist: { id: "a1", name: "Artist A" },
                        album: {
                            id: "al1",
                            title: "Album A",
                            coverArt: "/img/a.jpg",
                        },
                    },
                    null,
                    { title: "missing id" },
                    {
                        id: "t2",
                        title: "Second Track",
                        duration: 180,
                        artist: null,
                        album: null,
                    },
                ],
                currentIndex: 999,
                currentTime: -25,
                isShuffle: true,
                isPlaying: true,
            },
        } as any;
        const res = createRes();

        await postState(req, res);

        expect(mockSave).toHaveBeenCalledWith({
            where: { userId_deviceId: { userId: "u1", deviceId: "legacy" } },
            update: expect.objectContaining({
                playbackType: "track",
                trackId: "track-1",
                queue: [
                    expect.objectContaining({
                        id: "t1",
                        duration: 215,
                        mediaSource: "youtube",
                        streamSource: "youtube",
                        youtubeVideoId: "yt-123",
                        provider: expect.objectContaining({
                            source: "youtube",
                            providerTrackId: "yt-123",
                        }),
                    }),
                    expect.objectContaining({ id: "t2", duration: 180 }),
                ],
                currentIndex: 1,
                currentTime: 0,
                isShuffle: true,
                isPlaying: true,
            }),
            create: expect.objectContaining({
                userId: "u1",
                deviceId: "legacy",
                isPlaying: true,
                queue: [
                    expect.objectContaining({
                        id: "t1",
                        mediaSource: "youtube",
                        provider: expect.objectContaining({
                            source: "youtube",
                            providerTrackId: "yt-123",
                        }),
                    }),
                    expect.objectContaining({ id: "t2" }),
                ],
            }),
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "state-2",
                playbackType: "track",
            }),
        );
    });

    it("round-trips youtube-direct queue items with their audio format", async () => {
        mockSave.mockResolvedValueOnce({
            id: "state-yt-direct",
            userId: "u1",
            deviceId: "desktop",
            playbackType: "track",
        });

        const req = {
            user: { id: "u1" },
            header: () => "desktop",
            body: {
                playbackType: "track",
                trackId: "yt-dQw4w9WgXcQ",
                queue: [
                    {
                        id: "yt-dQw4w9WgXcQ",
                        title: "Some DJ Set",
                        duration: 7200,
                        streamSource: "youtube-direct",
                        youtubeVideoId: "dQw4w9WgXcQ",
                        youtubeAudioFormat: "webm",
                        artist: { name: "Uploader" },
                        album: { title: "YouTube" },
                    },
                ],
                currentIndex: 0,
            },
        } as any;
        const res = createRes();

        await postState(req, res);

        expect(mockSave).toHaveBeenCalledWith(
            expect.objectContaining({
                update: expect.objectContaining({
                    queue: [
                        expect.objectContaining({
                            id: "yt-dQw4w9WgXcQ",
                            mediaSource: "youtube-direct",
                            streamSource: "youtube-direct",
                            youtubeVideoId: "dQw4w9WgXcQ",
                            youtubeAudioFormat: "webm",
                            provider: expect.objectContaining({
                                source: "youtube-direct",
                                providerTrackId: "dQw4w9WgXcQ",
                                youtubeVideoId: "dQw4w9WgXcQ",
                                youtubeAudioFormat: "webm",
                            }),
                        }),
                    ],
                }),
            }),
        );
        expect(res.statusCode).toBe(200);
    });

    it("passes through podcast episode queue items and defaults tracks to itemType track", async () => {
        mockSave.mockResolvedValueOnce({
            id: "state-mixed",
            userId: "u1",
            deviceId: "legacy",
            playbackType: "podcast",
        });

        const req = {
            user: { id: "u1" },
            header: () => "",
            body: {
                playbackType: "podcast",
                podcastId: "pod-1:ep-1",
                queue: [
                    {
                        itemType: "episode",
                        id: "pod-1:ep-1",
                        title: "Episode One",
                        podcastTitle: "My Podcast",
                        podcastId: "pod-1",
                        episodeId: "ep-1",
                        coverUrl: "/covers/pod.jpg",
                        duration: "3600",
                        description: "should be stripped",
                    },
                    {
                        // Derives podcastId/episodeId from the composite id.
                        itemType: "episode",
                        id: "pod-2:ep-9",
                        title: "Episode Nine",
                        duration: 120,
                    },
                    {
                        id: "t1",
                        title: "Queued Track",
                        duration: 200,
                        artist: { id: "a1", name: "Artist A" },
                        album: { id: "al1", title: "Album A", coverArt: null },
                    },
                ],
                currentIndex: 0,
            },
        } as any;
        const res = createRes();

        await postState(req, res);

        const savedQueue = mockSave.mock.calls[0][0].update.queue;
        expect(savedQueue).toHaveLength(3);
        expect(savedQueue[0]).toEqual({
            itemType: "episode",
            id: "pod-1:ep-1",
            title: "Episode One",
            podcastTitle: "My Podcast",
            podcastId: "pod-1",
            episodeId: "ep-1",
            coverUrl: "/covers/pod.jpg",
            duration: 3600,
        });
        expect(savedQueue[1]).toEqual(
            expect.objectContaining({
                itemType: "episode",
                podcastId: "pod-2",
                episodeId: "ep-9",
                coverUrl: null,
            }),
        );
        expect(savedQueue[2]).toEqual(
            expect.objectContaining({
                itemType: "track",
                id: "t1",
                title: "Queued Track",
            }),
        );
        expect(res.statusCode).toBe(200);
    });

    it("falls back to DbNull when queue sanitization throws", async () => {
        mockSave.mockResolvedValueOnce({ id: "state-3" });

        const badItem: any = {};
        Object.defineProperty(badItem, "id", {
            get() {
                throw new Error("bad getter");
            },
        });

        const req = {
            user: { id: "u1" },
            header: () =>
                "device-id-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            body: {
                playbackType: "podcast",
                podcastId: "pod-9",
                queue: [badItem],
            },
        } as any;
        const res = createRes();

        await postState(req, res);

        const whereArg = mockSave.mock.calls[0][0].where;
        expect(whereArg.userId_deviceId.deviceId).toHaveLength(128);
        expect(mockSave.mock.calls[0][0].update.queue).toBe(
            (PrismaClient as any).DbNull,
        );
        expect(res.statusCode).toBe(200);
    });

    it("does not overwrite persisted play intent when isPlaying is omitted", async () => {
        mockSave.mockResolvedValueOnce({ id: "state-4" });

        const req = {
            user: { id: "u1" },
            header: () => "desktop",
            body: {
                playbackType: "track",
                trackId: "track-77",
            },
        } as any;
        const res = createRes();

        await postState(req, res);

        expect(mockSave.mock.calls[0][0].update).toEqual(
            expect.not.objectContaining({ isPlaying: expect.anything() }),
        );
        expect(mockSave.mock.calls[0][0].update).toEqual(
            expect.not.objectContaining({
                queue: expect.anything(),
                currentIndex: expect.anything(),
                isShuffle: expect.anything(),
                currentTime: expect.anything(),
            }),
        );
        expect(mockSave.mock.calls[0][0].create.isPlaying).toBe(false);
        expect(mockSave.mock.calls[0][0].create.currentTime).toBe(0);
        expect(mockSave.mock.calls[0][0].create.currentIndex).toBe(0);
        expect(mockSave.mock.calls[0][0].create.queue).toBe(
            (PrismaClient as any).DbNull,
        );
        expect(res.statusCode).toBe(200);
    });

    it("returns a sanitized 500 when save fails", async () => {
        mockSave.mockRejectedValueOnce(new Error("write failed"));

        const req = {
            user: { id: "u1" },
            header: () => "dev",
            body: { playbackType: "track", trackId: "t1" },
        } as any;
        const res = createRes();

        await postState(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to save playback state" });
        expect(JSON.stringify(res.body)).not.toContain("write failed");
    });

    it("clears only the current slot with a safe tombstone and sanitizes failures", async () => {
        mockSave.mockResolvedValueOnce({
            revision: "11111111-1111-4111-8111-111111111111",
        });
        const req = { user: { id: "u1" }, header: () => "mobile" } as any;
        const res = createRes();
        await deleteState(req, res);
        expect(mockSave).toHaveBeenCalledWith({
            where: { userId_deviceId: { userId: "u1", deviceId: "mobile" } },
            update: expect.objectContaining({
                isCleared: true,
                queue: (PrismaClient as any).DbNull,
                trackId: null,
                audiobookId: null,
                podcastId: null,
                currentTime: 0,
                currentIndex: 0,
                isPlaying: false,
                isShuffle: false,
            }),
            create: expect.objectContaining({
                userId: "u1",
                deviceId: "mobile",
                isCleared: true,
            }),
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });
        mockSave.mockRejectedValueOnce(new Error("delete failed"));
        const errorRes = createRes();
        await deleteState(req, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({
            error: "Failed to delete playback state",
        });
    });
});
