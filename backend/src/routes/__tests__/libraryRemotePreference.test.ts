import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const AUTH_HEADER = "x-test-auth";
const AUTH_VALUE = "ok";
const TEST_USER_ID = "user-1";

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

// ── Auth mock ────────────────────────────────────────────────────

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: Request, res: Response, next: NextFunction) => {
        if (req.header(AUTH_HEADER) !== AUTH_VALUE) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        req.user = { id: TEST_USER_ID, username: "tester", role: "user" };
        next();
    },
    requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
    requireAuthOrToken: (req: Request, res: Response, next: NextFunction) => {
        if (req.header(AUTH_HEADER) !== AUTH_VALUE) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        req.user = { id: TEST_USER_ID, username: "tester", role: "user" };
        next();
    },
}));

jest.mock("../../middleware/rateLimiter", () => ({
    coverArtLimiter: (_req: Request, _res: Response, next: NextFunction) =>
        next(),
    libraryMetadataLimiter: (
        _req: Request,
        _res: Response,
        next: NextFunction,
    ) => next(),
    streamingLimiter: (_req: Request, _res: Response, next: NextFunction) =>
        next(),
}));

// ── Logging ──────────────────────────────────────────────────────

jest.mock("../../utils/logger", () => {
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);
    return { logger };
});

// ── Prisma ───────────────────────────────────────────────────────

const mockPrisma = {
    likedRemoteTrack: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
    },
    remoteLikedTrack: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
    },
    // Stubs required by library.ts imports even though not used in these tests
    track: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
    },
    trackTidal: { findUnique: jest.fn(), upsert: jest.fn() },
    trackYtMusic: { findUnique: jest.fn(), upsert: jest.fn() },
    likedTrack: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        upsert: jest.fn(),
        createMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    dislikedEntity: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
        createMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    remotePreferenceIntent: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    play: {
        findFirst: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        groupBy: jest.fn(),
    },
    userSettings: { findUnique: jest.fn() },
    artist: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
        delete: jest.fn(),
    },
    album: {
        findMany: jest.fn(),
        groupBy: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
        update: jest.fn(),
    },
    audiobookProgress: { findMany: jest.fn() },
    podcastProgress: { findMany: jest.fn() },
    ownedAlbum: {
        groupBy: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        deleteMany: jest.fn(),
    },
    genre: { findMany: jest.fn() },
    similarArtist: { findMany: jest.fn(), deleteMany: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
};

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
    Prisma: {
        SortOrder: { asc: "asc", desc: "desc" },
        DbNull: null,
    },
}));

// ── Redis ────────────────────────────────────────────────────────

jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn(), setEx: jest.fn() },
}));

// ── Config ───────────────────────────────────────────────────────

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
            transcodeCachePath: "/tmp/soundspan-cache",
            transcodeCacheMaxGb: 1,
        },
    },
}));

// ── Service stubs (not exercised in remote-pref tests) ──────────

jest.mock("../../workers/queues", () => ({
    scanQueue: { add: jest.fn(), getJob: jest.fn() },
}));
jest.mock("../../workers/organizeSingles", () => ({
    organizeSingles: jest.fn(),
}));
jest.mock("../../services/lastfm", () => ({
    lastFmService: {
        getArtistTopTracks: jest.fn(),
        getSimilarArtists: jest.fn(),
    },
}));
jest.mock("../../services/fanart", () => ({ fanartService: {} }));
jest.mock("../../services/deezer", () => ({
    deezerService: { getAlbumCover: jest.fn(), getArtistImage: jest.fn() },
}));
jest.mock("../../services/imageProvider", () => ({
    imageProviderService: { getAlbumCover: jest.fn() },
}));
jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchArtist: jest.fn(),
        getReleaseGroups: jest.fn(),
    },
}));
jest.mock("../../services/coverArt", () => ({
    coverArtService: { getCoverArt: jest.fn(), clearNotFoundCache: jest.fn() },
}));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));
jest.mock("../../services/audioStreaming", () => ({
    AudioStreamingService: jest.fn().mockImplementation(() => ({
        getStreamFilePath: jest.fn(),
        streamFileWithRangeSupport: jest.fn(),
        destroy: jest.fn(),
    })),
}));
jest.mock("../../services/dataCache", () => ({
    dataCacheService: {
        getArtistImagesBatch: jest.fn(),
        getArtistImage: jest.fn(),
    },
}));
jest.mock("../../services/artistCountsService", () => ({
    backfillAllArtistCounts: jest.fn(),
    isBackfillNeeded: jest.fn(),
    getBackfillProgress: jest.fn(),
    isBackfillInProgress: jest.fn(),
}));
jest.mock("../../services/imageBackfill", () => ({
    isImageBackfillNeeded: jest.fn(),
    getImageBackfillProgress: jest.fn(),
    backfillAllImages: jest.fn(),
}));
jest.mock("../../utils/metadataOverrides", () => ({
    getMergedGenres: jest.fn(() => []),
    getArtistDisplaySummary: jest.fn(() => ""),
}));
jest.mock("../../utils/dateFilters", () => ({
    getEffectiveYear: jest.fn(),
    getDecadeWhereClause: jest.fn(),
    getDecadeFromYear: jest.fn(),
}));
jest.mock("../../utils/shuffle", () => ({
    shuffleArray: jest.fn((arr: unknown[]) => arr),
}));
jest.mock("../../utils/colorExtractor", () => ({
    extractColorsFromImage: jest.fn(async () => ({
        vibrant: "#000",
        darkVibrant: "#000",
        lightVibrant: "#000",
        muted: "#000",
        darkMuted: "#000",
        lightMuted: "#000",
    })),
}));
jest.mock("../../services/imageProxy", () => ({
    fetchExternalImage: jest.fn(),
    normalizeExternalImageUrl: jest.fn(() => null),
}));
jest.mock("../../services/imageStorage", () => ({
    downloadAndStoreImage: jest.fn(),
}));
jest.mock("../../services/lidarr", () => ({
    lidarrService: { deleteArtist: jest.fn() },
}));
jest.mock("music-metadata", () => ({ parseFile: jest.fn() }), {
    virtual: true,
});
jest.mock("../../services/trackMappingService", () => ({
    trackMappingService: {
        ensureRemoteTrack: jest.fn(),
    },
}));

jest.mock("../../services/remoteTrackMetadataResolver", () => ({
    resolveRemoteTrackMetadataForRequest: jest.fn(
        async ({ metadata }: any) => ({
            title: metadata.title ?? "Unknown",
            artist: metadata.artist ?? "Unknown",
            album: metadata.album ?? "Unknown",
            duration: metadata.duration ?? 180,
            thumbnailUrl: metadata.thumbnailUrl,
            isrc: metadata.isrc,
            explicit: metadata.explicit,
            quality: metadata.quality,
        }),
    ),
}));

// ── Router under test ────────────────────────────────────────────

jest.mock("../../services/metadata/catalogPersistence", () => ({
    findFreshCatalogAlbum: jest.fn(async () => null),
    findFreshCatalogReleaseGroups: jest.fn(async () => null),
    logCatalogPersistenceError: jest.fn(),
    persistCatalogReleaseGroups: jest.fn(async () => undefined),
    persistCatalogTracklist: jest.fn(async () => undefined),
    readFreshCatalogReleaseGroups: jest.fn(() => null),
}));

import router from "../library";
import { createRouteTestApp } from "./helpers/createRouteTestApp";
import { errorHandler } from "../../middleware/errorHandler";
import { trackMappingService } from "../../services/trackMappingService";
import { resolveRemoteTrackMetadataForRequest } from "../../services/remoteTrackMetadataResolver";

const app = createRouteTestApp("/api/library", router);
// Mount the real errorHandler after the router, as index.ts does in
// production: asyncHandler-migrated routes surface unexpected failures via
// next(err) -> errorHandler instead of responding from an inline catch.
app.use(errorHandler);
const mockEnsureRemoteTrack =
    trackMappingService.ensureRemoteTrack as jest.Mock;
const mockResolveRemoteTrackMetadataForRequest =
    resolveRemoteTrackMetadataForRequest as jest.Mock;

// ── Tests ────────────────────────────────────────────────────────

describe("library remote track preference endpoints", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPrisma.$transaction.mockImplementation(
            async (operation: (tx: typeof mockPrisma) => Promise<unknown>) =>
                operation(mockPrisma),
        );
        mockPrisma.remotePreferenceIntent.updateMany.mockResolvedValue({
            count: 1,
        });
        mockPrisma.remotePreferenceIntent.deleteMany.mockResolvedValue({
            count: 1,
        });
        mockEnsureRemoteTrack.mockImplementation(async (input: any) => ({
            provider: input.provider,
            id: input.provider === "tidal" ? "tt-default" : "yt-default",
            created: false,
        }));
        mockResolveRemoteTrackMetadataForRequest
            .mockReset()
            .mockImplementation(async ({ metadata }: any) => ({
                title: metadata.title ?? "Unknown",
                artist: metadata.artist ?? "Unknown",
                album: metadata.album ?? "Unknown",
                duration: metadata.duration ?? 180,
                thumbnailUrl: metadata.thumbnailUrl,
                isrc: metadata.isrc,
                explicit: metadata.explicit,
                quality: metadata.quality,
            }));
    });

    // ── parseRemoteTrackId validation ────────────────────────────

    describe("GET /api/library/remote-tracks/:id/preference", () => {
        it("returns 400 for invalid composite ID (no prefix)", async () => {
            const res = await request(app)
                .get("/api/library/remote-tracks/plain-id-123/preference")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/invalid remote track id/i);
        });

        it("returns 400 for numeric-only ID", async () => {
            const res = await request(app)
                .get("/api/library/remote-tracks/12345/preference")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(400);
        });

        it("returns preference for yt: prefixed track", async () => {
            mockPrisma.trackYtMusic.findUnique.mockResolvedValueOnce({
                id: "yt-row-1",
            });
            mockPrisma.likedRemoteTrack.findUnique.mockResolvedValueOnce({
                likedAt: new Date("2026-01-15T10:00:00Z"),
            });

            const res = await request(app)
                .get("/api/library/remote-tracks/yt:dQw4w9WgXcQ/preference")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
            expect(res.body.trackId).toBe("yt:dQw4w9WgXcQ");
            expect(res.body.signal).toBe("thumbs_up");
            expect(res.body.likedAt).toBeTruthy();

            expect(mockPrisma.likedRemoteTrack.findUnique).toHaveBeenCalledWith(
                {
                    where: {
                        userId_trackYtMusicId: {
                            userId: TEST_USER_ID,
                            trackYtMusicId: "yt-row-1",
                        },
                    },
                    select: { likedAt: true },
                },
            );
            expect(
                mockPrisma.remoteLikedTrack.findUnique,
            ).not.toHaveBeenCalled();
            expect(mockPrisma.dislikedEntity.findUnique).toHaveBeenCalledWith({
                where: {
                    userId_entityType_entityId: {
                        userId: TEST_USER_ID,
                        entityType: "track",
                        entityId: "yt:dQw4w9WgXcQ",
                    },
                },
                select: { dislikedAt: true },
            });
        });

        it("returns preference for tidal: prefixed track", async () => {
            mockPrisma.trackTidal.findUnique.mockResolvedValueOnce({
                id: "tidal-row-1",
            });
            mockPrisma.likedRemoteTrack.findUnique.mockResolvedValueOnce(null);

            const res = await request(app)
                .get("/api/library/remote-tracks/tidal:123456789/preference")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
            expect(res.body.trackId).toBe("tidal:123456789");
            expect(res.body.signal).toBe("clear");
            expect(res.body.state).toBe("neutral");
            expect(res.body.likedAt).toBeNull();

            expect(mockPrisma.likedRemoteTrack.findUnique).toHaveBeenCalledWith(
                {
                    where: {
                        userId_trackTidalId: {
                            userId: TEST_USER_ID,
                            trackTidalId: "tidal-row-1",
                        },
                    },
                    select: { likedAt: true },
                },
            );
            expect(mockPrisma.dislikedEntity.findUnique).toHaveBeenCalledWith({
                where: {
                    userId_entityType_entityId: {
                        userId: TEST_USER_ID,
                        entityType: "track",
                        entityId: "tidal:123456789",
                    },
                },
                select: { dislikedAt: true },
            });
        });

        it("returns a persisted canonical YouTube dislike without requiring a materialized track", async () => {
            const dislikedAt = new Date("2026-01-16T10:00:00Z");
            mockPrisma.trackYtMusic.findUnique.mockResolvedValueOnce(null);
            mockPrisma.dislikedEntity.findUnique.mockResolvedValueOnce({
                dislikedAt,
            });

            const res = await request(app)
                .get("/api/library/remote-tracks/yt:disliked-video/preference")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
            expect(res.body).toEqual(
                expect.objectContaining({
                    trackId: "yt:disliked-video",
                    signal: "thumbs_down",
                    state: "disliked",
                    likedAt: null,
                    dislikedAt: dislikedAt.toISOString(),
                }),
            );
            expect(
                mockPrisma.likedRemoteTrack.findUnique,
            ).not.toHaveBeenCalled();
        });

        it("requires authentication", async () => {
            const res = await request(app).get(
                "/api/library/remote-tracks/yt:abc/preference",
            );

            expect(res.status).toBe(401);
        });

        it("returns 500 when prisma throws", async () => {
            mockPrisma.trackYtMusic.findUnique.mockResolvedValueOnce({
                id: "yt-row-err",
            });
            mockPrisma.likedRemoteTrack.findUnique.mockRejectedValueOnce(
                new Error("DB connection lost"),
            );

            const res = await request(app)
                .get("/api/library/remote-tracks/yt:abc/preference")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(500);
        });
    });

    // ── POST set preference ──────────────────────────────────────

    describe("POST /api/library/remote-tracks/:id/preference", () => {
        it("returns 400 for invalid composite ID", async () => {
            const res = await request(app)
                .post("/api/library/remote-tracks/invalid-id/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ signal: "thumbs_up" });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/invalid remote track id/i);
        });

        it("returns 400 for missing signal", async () => {
            const res = await request(app)
                .post("/api/library/remote-tracks/yt:vid123/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({});

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/invalid preference signal/i);
        });

        it("returns 400 for unknown signal value", async () => {
            const res = await request(app)
                .post("/api/library/remote-tracks/yt:vid123/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ signal: "super_like" });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/invalid preference signal/i);
        });

        it("upserts FK likes on thumbs_up with metadata", async () => {
            mockEnsureRemoteTrack.mockResolvedValueOnce({
                provider: "youtube",
                id: "yt-row-1",
                created: true,
            });
            mockPrisma.likedRemoteTrack.upsert.mockResolvedValueOnce({});

            const metadata = {
                title: "Never Gonna Give You Up",
                artist: "Rick Astley",
                album: "Whenever You Need Somebody",
                thumbnailUrl: "https://img.youtube.com/vi/dQw4w9WgXcQ/0.jpg",
                duration: 213,
            };

            const res = await request(app)
                .post("/api/library/remote-tracks/yt:dQw4w9WgXcQ/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ signal: "thumbs_up", metadata });

            expect(res.status).toBe(200);
            expect(res.body.trackId).toBe("yt:dQw4w9WgXcQ");
            expect(res.body.signal).toBe("thumbs_up");
            expect(
                mockResolveRemoteTrackMetadataForRequest,
            ).toHaveBeenCalledWith(
                expect.objectContaining({ fetchArtworkIfMissing: true }),
            );
            expect(mockEnsureRemoteTrack).toHaveBeenCalledWith(
                expect.objectContaining({
                    provider: "youtube",
                    videoId: "dQw4w9WgXcQ",
                    title: "Never Gonna Give You Up",
                    artist: "Rick Astley",
                    album: "Whenever You Need Somebody",
                    duration: 213,
                }),
            );
            expect(mockPrisma.likedRemoteTrack.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        userId_trackYtMusicId: {
                            userId: TEST_USER_ID,
                            trackYtMusicId: "yt-row-1",
                        },
                    },
                }),
            );
            expect(mockPrisma.dislikedEntity.deleteMany).toHaveBeenCalledWith({
                where: {
                    userId: TEST_USER_ID,
                    entityType: "track",
                    entityId: "yt:dQw4w9WgXcQ",
                },
            });
        });

        it("repairs placeholder metadata inline before liking a tidal track", async () => {
            mockEnsureRemoteTrack.mockResolvedValueOnce({
                provider: "tidal",
                id: "tt-repaired",
                created: false,
            });
            mockPrisma.likedRemoteTrack.upsert.mockResolvedValueOnce({});
            mockResolveRemoteTrackMetadataForRequest.mockResolvedValueOnce({
                title: "Blinded By The Light",
                artist: "Manfred Mann's Earth Band",
                album: "The Roaring Silence",
                duration: 428,
                isrc: "USWB10800347",
                explicit: false,
            });

            const res = await request(app)
                .post("/api/library/remote-tracks/tidal:69778330/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({
                    signal: "thumbs_up",
                    metadata: {
                        title: "Unknown",
                        artist: "Unknown",
                        album: "Unknown",
                        duration: 180,
                    },
                });

            expect(res.status).toBe(200);
            expect(
                mockResolveRemoteTrackMetadataForRequest,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    provider: "tidal",
                    userId: TEST_USER_ID,
                    tidalId: 69778330,
                }),
            );
            expect(mockEnsureRemoteTrack).toHaveBeenCalledWith(
                expect.objectContaining({
                    provider: "tidal",
                    tidalId: 69778330,
                    title: "Blinded By The Light",
                    artist: "Manfred Mann's Earth Band",
                    album: "The Roaring Silence",
                    duration: 428,
                    isrc: "USWB10800347",
                    explicit: false,
                }),
            );
        });

        it("keeps a later dislike when an equal-time older like finishes materializing last", async () => {
            const fixedTimestamp = Date.parse("2026-01-17T12:00:00.000Z");
            const NativeDate = Date;
            class FixedDate extends NativeDate {
                constructor(value?: string | number | Date) {
                    super(
                        arguments.length === 0
                            ? fixedTimestamp
                            : (value as string | number),
                    );
                }

                static override now() {
                    return fixedTimestamp;
                }
            }

            const materializationStarted = createDeferred<void>();
            const releaseMaterialization = createDeferred<void>();
            let likedAt: Date | null = null;
            let dislikedAt: Date | null = null;
            let latestIntentToken: string | null = null;

            mockResolveRemoteTrackMetadataForRequest.mockImplementationOnce(
                async ({ metadata }: any) => {
                    materializationStarted.resolve();
                    await releaseMaterialization.promise;
                    return {
                        title: metadata.title,
                        artist: metadata.artist,
                        album: metadata.album,
                        duration: metadata.duration,
                    };
                },
            );
            mockEnsureRemoteTrack.mockResolvedValueOnce({
                provider: "youtube",
                id: "yt-race-row",
                created: true,
            });
            mockPrisma.trackYtMusic.findUnique.mockImplementation(async () => ({
                id: "yt-race-row",
            }));
            mockPrisma.likedRemoteTrack.findUnique.mockImplementation(
                async () => (likedAt ? { likedAt } : null),
            );
            mockPrisma.likedRemoteTrack.deleteMany.mockImplementation(
                async () => {
                    likedAt = null;
                    return { count: 1 };
                },
            );
            mockPrisma.likedRemoteTrack.upsert.mockImplementation(
                async ({ create, update }: any) => {
                    likedAt = update.likedAt ?? create.likedAt;
                    return {};
                },
            );
            mockPrisma.dislikedEntity.findUnique.mockImplementation(async () =>
                dislikedAt ? { dislikedAt } : null,
            );
            mockPrisma.dislikedEntity.deleteMany.mockImplementation(
                async () => {
                    dislikedAt = null;
                    return { count: 1 };
                },
            );
            mockPrisma.dislikedEntity.upsert.mockImplementation(
                async ({ create, update }: any) => {
                    dislikedAt = update.dislikedAt ?? create.dislikedAt;
                    return {};
                },
            );
            mockPrisma.remotePreferenceIntent.upsert.mockImplementation(
                async ({ create, update }: any) => {
                    latestIntentToken = update.token ?? create.token;
                    return { token: latestIntentToken };
                },
            );
            mockPrisma.remotePreferenceIntent.findUnique.mockImplementation(
                async () =>
                    latestIntentToken ? { token: latestIntentToken } : null,
            );
            mockPrisma.remotePreferenceIntent.updateMany.mockImplementation(
                async ({ where }: any) => ({
                    count: where.token === latestIntentToken ? 1 : 0,
                }),
            );

            global.Date = FixedDate as DateConstructor;
            try {
                const olderLikeRequest = request(app)
                    .post("/api/library/remote-tracks/yt:race/preference")
                    .set(AUTH_HEADER, AUTH_VALUE)
                    .send({
                        signal: "thumbs_up",
                        metadata: {
                            title: "Older Like",
                            artist: "Artist",
                            album: "Album",
                            duration: 180,
                        },
                    })
                    .then((response) => response);

                await materializationStarted.promise;

                const newerDislikeResponse = await request(app)
                    .post("/api/library/remote-tracks/yt:race/preference")
                    .set(AUTH_HEADER, AUTH_VALUE)
                    .send({ signal: "thumbs_down" });

                releaseMaterialization.resolve();
                const olderLikeResponse = await olderLikeRequest;

                expect(newerDislikeResponse.status).toBe(200);
                expect(newerDislikeResponse.body.signal).toBe("thumbs_down");
                expect(olderLikeResponse.status).toBe(200);
                expect(olderLikeResponse.body.signal).toBe("thumbs_down");
                expect(likedAt).toBeNull();
                expect(dislikedAt).toEqual(new Date(fixedTimestamp));
            } finally {
                global.Date = NativeDate;
                mockPrisma.trackYtMusic.findUnique.mockReset();
                mockPrisma.likedRemoteTrack.findUnique.mockReset();
                mockPrisma.likedRemoteTrack.deleteMany.mockReset();
                mockPrisma.likedRemoteTrack.upsert.mockReset();
                mockPrisma.dislikedEntity.findUnique.mockReset();
                mockPrisma.dislikedEntity.deleteMany.mockReset();
                mockPrisma.dislikedEntity.upsert.mockReset();
                mockPrisma.remotePreferenceIntent.findUnique.mockReset();
                mockPrisma.remotePreferenceIntent.upsert.mockReset();
                mockPrisma.remotePreferenceIntent.updateMany.mockReset();
            }
        });

        it("upserts tidal: track on thumbs_up", async () => {
            mockEnsureRemoteTrack.mockResolvedValueOnce({
                provider: "tidal",
                id: "tidal-row-1",
                created: true,
            });
            mockPrisma.likedRemoteTrack.upsert.mockResolvedValueOnce({});

            const res = await request(app)
                .post("/api/library/remote-tracks/tidal:987654/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({
                    signal: "thumbs_up",
                    metadata: { title: "Song", artist: "Artist" },
                });

            expect(res.status).toBe(200);
            expect(mockEnsureRemoteTrack).toHaveBeenCalledWith(
                expect.objectContaining({
                    provider: "tidal",
                    tidalId: 987654,
                }),
            );
            expect(mockPrisma.likedRemoteTrack.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        userId_trackTidalId: {
                            userId: TEST_USER_ID,
                            trackTidalId: "tidal-row-1",
                        },
                    },
                }),
            );
        });

        it("atomically replaces a YouTube like with a canonical per-user dislike", async () => {
            mockPrisma.trackYtMusic.findUnique.mockResolvedValueOnce({
                id: "yt-row-delete",
            });
            mockPrisma.likedRemoteTrack.deleteMany.mockResolvedValueOnce({
                count: 1,
            });

            const res = await request(app)
                .post("/api/library/remote-tracks/yt:vid456/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ signal: "thumbs_down" });

            expect(res.status).toBe(200);
            expect(res.body.signal).toBe("thumbs_down");
            expect(res.body.state).toBe("disliked");
            expect(res.body.dislikedAt).toBeTruthy();
            expect(mockPrisma.likedRemoteTrack.deleteMany).toHaveBeenCalledWith(
                {
                    where: {
                        userId: TEST_USER_ID,
                        trackYtMusicId: "yt-row-delete",
                    },
                },
            );
            expect(mockPrisma.dislikedEntity.upsert).toHaveBeenCalledWith({
                where: {
                    userId_entityType_entityId: {
                        userId: TEST_USER_ID,
                        entityType: "track",
                        entityId: "yt:vid456",
                    },
                },
                create: expect.objectContaining({
                    userId: TEST_USER_ID,
                    entityType: "track",
                    entityId: "yt:vid456",
                    dislikedAt: expect.any(Date),
                }),
                update: { dislikedAt: expect.any(Date) },
            });
            expect(mockPrisma.$transaction).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ isolationLevel: "Serializable" }),
            );
        });

        it("normalizes a TIDAL dislike to its numeric canonical id", async () => {
            mockPrisma.trackTidal.findUnique.mockResolvedValueOnce({
                id: "tidal-row-disliked",
            });

            const res = await request(app)
                .post("/api/library/remote-tracks/tidal:000987654/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ signal: "thumbs_down" });

            expect(res.status).toBe(200);
            expect(res.body.signal).toBe("thumbs_down");
            expect(mockPrisma.likedRemoteTrack.deleteMany).toHaveBeenCalledWith(
                {
                    where: {
                        userId: TEST_USER_ID,
                        trackTidalId: "tidal-row-disliked",
                    },
                },
            );
            expect(mockPrisma.dislikedEntity.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        userId_entityType_entityId: {
                            userId: TEST_USER_ID,
                            entityType: "track",
                            entityId: "tidal:987654",
                        },
                    },
                }),
            );
        });

        it("keeps repeated thumbs_down requests idempotent on the same canonical row", async () => {
            mockPrisma.trackYtMusic.findUnique.mockResolvedValue(null);

            const first = await request(app)
                .post("/api/library/remote-tracks/yt:repeatable/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ signal: "thumbs_down" });
            const second = await request(app)
                .post("/api/library/remote-tracks/yt:repeatable/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ signal: "thumbs_down" });

            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(mockPrisma.dislikedEntity.upsert).toHaveBeenCalledTimes(2);
            for (const [mutation] of mockPrisma.dislikedEntity.upsert.mock
                .calls) {
                expect(mutation.where).toEqual({
                    userId_entityType_entityId: {
                        userId: TEST_USER_ID,
                        entityType: "track",
                        entityId: "yt:repeatable",
                    },
                });
            }
        });

        it("retries a serialization abort without duplicating remote preference state", async () => {
            const serializationError = Object.assign(
                new Error("could not serialize access"),
                { code: "P2034" },
            );
            mockPrisma.$transaction
                .mockRejectedValueOnce(serializationError)
                .mockImplementationOnce(
                    async (
                        operation: (tx: typeof mockPrisma) => Promise<unknown>,
                    ) => operation(mockPrisma),
                );
            mockPrisma.trackYtMusic.findUnique.mockResolvedValueOnce(null);

            const res = await request(app)
                .post("/api/library/remote-tracks/yt:retryable/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ signal: "thumbs_down" });

            expect(res.status).toBe(200);
            expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
            expect(
                mockPrisma.remotePreferenceIntent.upsert,
            ).toHaveBeenCalledTimes(1);
            expect(mockPrisma.dislikedEntity.upsert).toHaveBeenCalledTimes(1);
        });

        it("deletes FK likes on clear signal", async () => {
            mockPrisma.trackYtMusic.findUnique.mockResolvedValueOnce(null);

            const res = await request(app)
                .post("/api/library/remote-tracks/yt:vid789/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ signal: "clear" });

            expect(res.status).toBe(200);
            expect(res.body.signal).toBe("clear");
            expect(res.body.state).toBe("neutral");
            expect(
                mockPrisma.likedRemoteTrack.deleteMany,
            ).not.toHaveBeenCalled();
            expect(mockPrisma.dislikedEntity.deleteMany).toHaveBeenCalledWith({
                where: {
                    userId: TEST_USER_ID,
                    entityType: "track",
                    entityId: "yt:vid789",
                },
            });
        });

        it("accepts numeric score as alias (positive → thumbs_up)", async () => {
            mockPrisma.likedRemoteTrack.upsert.mockResolvedValueOnce({});

            const res = await request(app)
                .post("/api/library/remote-tracks/yt:vid-score/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ score: 1 });

            expect(res.status).toBe(200);
            expect(res.body.signal).toBe("thumbs_up");
            expect(mockPrisma.likedRemoteTrack.upsert).toHaveBeenCalled();
        });

        it("accepts numeric score as alias (negative → thumbs_down)", async () => {
            mockPrisma.trackYtMusic.findUnique.mockResolvedValueOnce({
                id: "yt-row-neg",
            });
            mockPrisma.likedRemoteTrack.deleteMany.mockResolvedValueOnce({
                count: 1,
            });

            const res = await request(app)
                .post("/api/library/remote-tracks/yt:vid-neg/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ score: -1 });

            expect(res.status).toBe(200);
            expect(res.body.signal).toBe("thumbs_down");
            expect(mockPrisma.likedRemoteTrack.deleteMany).toHaveBeenCalledWith(
                {
                    where: {
                        userId: TEST_USER_ID,
                        trackYtMusicId: "yt-row-neg",
                    },
                },
            );
            expect(mockPrisma.dislikedEntity.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        userId_entityType_entityId: {
                            userId: TEST_USER_ID,
                            entityType: "track",
                            entityId: "yt:vid-neg",
                        },
                    },
                }),
            );
        });

        it("rejects a non-numeric TIDAL dislike without persisting state", async () => {
            const res = await request(app)
                .post(
                    "/api/library/remote-tracks/tidal:not-a-number/preference",
                )
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ signal: "thumbs_down" });

            expect(res.status).toBe(400);
            expect(mockPrisma.$transaction).not.toHaveBeenCalled();
            expect(mockPrisma.dislikedEntity.upsert).not.toHaveBeenCalled();
        });

        it("requires authentication", async () => {
            const res = await request(app)
                .post("/api/library/remote-tracks/yt:abc/preference")
                .send({ signal: "thumbs_up" });

            expect(res.status).toBe(401);
        });

        it("cleans the latest intent when provider materialization fails", async () => {
            mockResolveRemoteTrackMetadataForRequest.mockRejectedValueOnce(
                new Error("provider unavailable"),
            );

            const res = await request(app)
                .post("/api/library/remote-tracks/yt:provider-error/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ signal: "thumbs_up" });

            expect(res.status).toBe(500);
            expect(
                mockPrisma.remotePreferenceIntent.deleteMany,
            ).toHaveBeenCalledWith({
                where: {
                    userId: TEST_USER_ID,
                    remoteTrackId: "yt:provider-error",
                    token: expect.any(String),
                },
            });
            expect(
                mockPrisma.remotePreferenceIntent.updateMany,
            ).not.toHaveBeenCalled();
            expect(mockPrisma.likedRemoteTrack.upsert).not.toHaveBeenCalled();
        });

        it("returns 500 when prisma throws on upsert", async () => {
            mockPrisma.likedRemoteTrack.upsert.mockRejectedValueOnce(
                new Error("unique constraint"),
            );

            const res = await request(app)
                .post("/api/library/remote-tracks/yt:vid-err/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({
                    signal: "thumbs_up",
                    metadata: { title: "T", artist: "A" },
                });

            expect(res.status).toBe(500);
            expect(
                mockPrisma.remotePreferenceIntent.deleteMany,
            ).toHaveBeenCalledWith({
                where: {
                    userId: TEST_USER_ID,
                    remoteTrackId: "yt:vid-err",
                    token: expect.any(String),
                },
            });
        });

        it("defaults metadata fields to 'Unknown' when not provided", async () => {
            mockPrisma.likedRemoteTrack.upsert.mockResolvedValueOnce({});

            const res = await request(app)
                .post("/api/library/remote-tracks/yt:vid-no-meta/preference")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ signal: "thumbs_up" });

            expect(res.status).toBe(200);
            expect(mockEnsureRemoteTrack).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: "Unknown",
                    artist: "Unknown",
                    album: "Unknown",
                    duration: 180,
                }),
            );
        });
    });
});

describe("remote-only album loading regression", () => {
    it("loads a liked TIDAL-only remote album instead of returning 404", async () => {
        mockPrisma.album.findFirst.mockResolvedValueOnce({
            id: "album-remote-1",
            rgMbid: "remote:test-album",
            title: "Remote Album",
            artistId: "artist-remote-1",
            location: "REMOTE",
            primaryType: "Album",
            coverUrl: "https://example.test/cover.jpg",
            artist: {
                id: "artist-remote-1",
                mbid: null,
                name: "Remote Artist",
            },
            federationPeer: null,
            tracks: [],
            tracksTidal: [
                {
                    id: "tidal-row-1",
                    tidalId: 123456,
                    title: "Remote Song",
                    artist: "Remote Artist",
                    artistId: "artist-remote-1",
                    album: "Remote Album",
                    albumId: "album-remote-1",
                    duration: 240,
                    isrc: null,
                    quality: null,
                    explicit: false,
                },
            ],
            tracksYtMusic: [],
        });
        mockPrisma.ownedAlbum.findUnique.mockResolvedValueOnce(null);

        const res = await request(app)
            .get("/api/library/albums/album-remote-1")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body.id).toBe("album-remote-1");
        expect(res.body.source).toBe("remote");
        expect(res.body.owned).toBe(false);
        expect(res.body).not.toHaveProperty("tracksTidal");
        expect(res.body).not.toHaveProperty("tracksYtMusic");
        expect(res.body.tracks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: "tidal:123456",
                    source: "tidal",
                    streamSource: "tidal",
                }),
            ]),
        );
    });
});
