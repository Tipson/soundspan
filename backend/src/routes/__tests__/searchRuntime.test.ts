import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
        },
        similarArtist: {
            findMany: jest.fn(),
        },
        genre: {
            findMany: jest.fn(),
        },
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(),
        setEx: jest.fn(),
    },
}));

jest.mock("../../services/lastfm", () => ({
    lastFmService: {
        isConfigured: jest.fn(),
        getArtistCorrection: jest.fn(),
        searchArtists: jest.fn(),
        searchTracks: jest.fn(),
        getSimilarArtists: jest.fn(),
        enrichSimilarArtists: jest.fn(),
    },
}));

jest.mock("../../services/youtubeMusic", () => ({
    ytMusicService: {
        searchCanonical: jest.fn(),
        searchCatalog: jest.fn(),
    },
}));

jest.mock("../../services/ytMusicDiscoveryCatalog", () => ({
    searchYtMusicDiscoveryCatalog: jest.fn(),
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        get: jest.fn(),
    },
}));

jest.mock("../../services/search", () => ({
    searchService: {
        searchAll: jest.fn(),
        searchByType: jest.fn(),
    },
    normalizeCacheQuery: (query: string) => query.trim().toLowerCase(),
}));

import axios from "axios";
import router from "../search";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { lastFmService } from "../../services/lastfm";
import { ytMusicService } from "../../services/youtubeMusic";
import { searchYtMusicDiscoveryCatalog } from "../../services/ytMusicDiscoveryCatalog";
import { searchService } from "../../services/search";
import { getSystemSettings } from "../../utils/systemSettings";

const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
const mockArtistFindFirst = prisma.artist.findFirst as jest.Mock;
const mockSimilarArtistFindMany = prisma.similarArtist.findMany as jest.Mock;
const mockGenreFindMany = prisma.genre.findMany as jest.Mock;
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;
const mockGetArtistCorrection = lastFmService.getArtistCorrection as jest.Mock;
const mockIsLastFmConfigured = lastFmService.isConfigured as jest.Mock;
const mockSearchArtists = lastFmService.searchArtists as jest.Mock;
const mockSearchTracks = lastFmService.searchTracks as jest.Mock;
const mockYtMusicSearch = ytMusicService.searchCanonical as jest.Mock;
const mockYtMusicCatalogSearch = ytMusicService.searchCatalog as jest.Mock;
const mockYtMusicDiscoverySearch = searchYtMusicDiscoveryCatalog as jest.Mock;
const mockGetSystemSettings = getSystemSettings as jest.Mock;
const mockGetSimilarArtists = lastFmService.getSimilarArtists as jest.Mock;
const mockEnrichSimilarArtists =
    lastFmService.enrichSimilarArtists as jest.Mock;
const mockSearchAll = searchService.searchAll as jest.Mock;
const mockSearchByType = searchService.searchByType as jest.Mock;
const mockAxiosGet = (axios as any).get as jest.Mock;

function getGetHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.get,
    );
    if (!layer) {
        throw new Error(`Route not found: ${path}`);
    }
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
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

describe("search route runtime behavior", () => {
    const rootHandler = getGetHandler("/");
    const genresHandler = getGetHandler("/genres");
    const discoverHandler = getGetHandler("/discover");
    const discoverSimilarHandler = getGetHandler("/discover/similar");

    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");
        mockArtistFindMany.mockResolvedValue([]);
        mockArtistFindFirst.mockResolvedValue(null);
        mockSimilarArtistFindMany.mockResolvedValue([]);
        mockGenreFindMany.mockResolvedValue([]);
        mockGetArtistCorrection.mockResolvedValue(null);
        mockIsLastFmConfigured.mockResolvedValue(true);
        mockSearchArtists.mockResolvedValue([]);
        mockSearchTracks.mockResolvedValue([]);
        mockYtMusicSearch.mockResolvedValue({
            query: "",
            filter: "songs",
            total: 0,
            results: [],
        });
        mockYtMusicCatalogSearch.mockImplementation(
            async (
                _userId: string,
                query: string,
                filter: "albums" | "artists",
            ) => ({ query, filter, total: 0, results: [] }),
        );
        mockYtMusicDiscoverySearch.mockImplementation(
            async (
                _transport: unknown,
                userId: string,
                query: string,
                limit: number,
                options: { timeoutMs: number; maxRetries: number },
            ) => {
                const [tracks, albums, artists] = await Promise.all([
                    mockYtMusicSearch(userId, query, "songs", limit, options),
                    mockYtMusicCatalogSearch(
                        userId,
                        query,
                        "albums",
                        limit,
                        options,
                    ),
                    mockYtMusicCatalogSearch(
                        userId,
                        query,
                        "artists",
                        limit,
                        options,
                    ),
                ]);
                return {
                    tracks: tracks.results,
                    albums: albums.results,
                    artists: artists.results,
                    failedFilters: [],
                };
            },
        );
        mockGetSystemSettings.mockResolvedValue({ ytMusicEnabled: true });
        mockGetSimilarArtists.mockResolvedValue([]);
        mockEnrichSimilarArtists.mockResolvedValue([]);
        mockSearchAll.mockResolvedValue({
            artists: [],
            albums: [],
            tracks: [],
            audiobooks: [],
            podcasts: [],
            episodes: [],
        });
        mockSearchByType.mockResolvedValue({
            artists: [],
            albums: [],
            tracks: [],
            audiobooks: [],
            podcasts: [],
            episodes: [],
        });
        mockAxiosGet.mockResolvedValue({ data: { results: [] } });
    });

    it("returns empty payload when query is blank", async () => {
        const req = { query: { q: "   " } } as any;
        const res = createRes();

        await rootHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            artists: [],
            albums: [],
            tracks: [],
            audiobooks: [],
            podcasts: [],
            episodes: [],
        });
        expect(mockSearchAll).not.toHaveBeenCalled();
        expect(mockSearchByType).not.toHaveBeenCalled();
    });

    it("uses searchAll with clamped limit and transforms response shape", async () => {
        mockSearchAll.mockResolvedValueOnce({
            artists: [{ id: "artist-1", name: "Radiohead", mbid: "mbid-1" }],
            albums: [
                {
                    id: "album-1",
                    title: "Kid A",
                    artistId: "artist-1",
                    artistName: "Radiohead",
                    year: 2000,
                    coverUrl: "cover.jpg",
                },
            ],
            tracks: [
                {
                    id: "track-1",
                    title: "Everything In Its Right Place",
                    artistId: "artist-1",
                    artistName: "Radiohead",
                    albumId: "album-1",
                    albumTitle: "Kid A",
                    duration: 250,
                    loudnessLufs: -18.2,
                    truePeakDb: -1.3,
                    albumLoudnessLufs: -17.8,
                    albumTruePeakDb: -0.9,
                },
            ],
            audiobooks: [{ id: "book-1" }],
            podcasts: [{ id: "pod-1" }],
            episodes: [{ id: "ep-1" }],
        });

        const req = {
            query: {
                q: "  radiohead ",
                type: "all",
                limit: "999",
                offset: "50",
                genre: "alt",
            },
        } as any;
        const res = createRes();

        await rootHandler(req, res);

        expect(mockSearchAll).toHaveBeenCalledWith({
            query: "radiohead",
            limit: 100,
            genre: "alt",
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                artists: [
                    { id: "artist-1", name: "Radiohead", mbid: "mbid-1" },
                ],
                albums: [
                    expect.objectContaining({
                        id: "album-1",
                        title: "Kid A",
                        artist: expect.objectContaining({
                            id: "artist-1",
                            name: "Radiohead",
                            mbid: "",
                        }),
                    }),
                ],
                tracks: [
                    expect.objectContaining({
                        id: "track-1",
                        title: "Everything In Its Right Place",
                        trackNo: 0,
                        loudnessLufs: -18.2,
                        truePeakDb: -1.3,
                        album: expect.objectContaining({
                            id: "album-1",
                            title: "Kid A",
                            albumLoudnessLufs: -17.8,
                            albumTruePeakDb: -0.9,
                            artist: expect.objectContaining({
                                id: "artist-1",
                                name: "Radiohead",
                                mbid: "",
                            }),
                        }),
                    }),
                ],
                audiobooks: [{ id: "book-1" }],
                podcasts: [{ id: "pod-1" }],
                episodes: [{ id: "ep-1" }],
            }),
        );
    });

    it("uses searchByType with lower bound limit clamp", async () => {
        const req = {
            query: { q: "dj", type: "artists", limit: "0" },
        } as any;
        const res = createRes();

        await rootHandler(req, res);

        expect(mockSearchByType).toHaveBeenCalledWith({
            query: "dj",
            type: "artists",
            limit: 1,
            offset: 0,
            genre: undefined,
        });
        expect(res.statusCode).toBe(200);
    });

    it("passes a validated offset to type-scoped search", async () => {
        const req = {
            query: { q: "creep", type: "tracks", offset: "25" },
        } as any;
        const res = createRes();

        await rootHandler(req, res);

        expect(mockSearchByType).toHaveBeenCalledWith({
            query: "creep",
            type: "tracks",
            limit: 20,
            offset: 25,
            genre: undefined,
        });
        expect(res.statusCode).toBe(200);
    });

    it.each(["-1", "10001", "1.5", "not-a-number"])(
        "rejects invalid offset %s",
        async (offset) => {
            const req = {
                query: { q: "creep", type: "tracks", offset },
            } as any;
            const res = createRes();

            await rootHandler(req, res);

            expect(mockSearchByType).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: "Invalid search query" });
        },
    );

    it("passes a validated peers source filter to the search service", async () => {
        const req = {
            query: { q: "shared", type: "tracks", source: "peers" },
        } as any;
        const res = createRes();

        await rootHandler(req, res);

        expect(mockSearchByType).toHaveBeenCalledWith({
            query: "shared",
            type: "tracks",
            limit: 20,
            offset: 0,
            genre: undefined,
            source: "peers",
        });
        expect(res.statusCode).toBe(200);
    });

    it("rejects an unknown search source before querying", async () => {
        const req = {
            query: { q: "shared", type: "tracks", source: "internet" },
        } as any;
        const res = createRes();

        await rootHandler(req, res);

        expect(mockSearchByType).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Invalid search query" });
    });

    it("ignores undeclared search parameters for caller compatibility", async () => {
        const req = {
            query: {
                q: "shared",
                type: "tracks",
                thirdPartyHint: "preserve-compatibility",
            },
        } as any;
        const res = createRes();

        await rootHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockSearchByType).toHaveBeenCalledWith({
            query: "shared",
            type: "tracks",
            limit: 20,
            offset: 0,
            genre: undefined,
        });
    });

    it("rejects search queries longer than 500 characters", async () => {
        const req = { query: { q: "x".repeat(501) } } as any;
        const res = createRes();

        await rootHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Invalid search query" });
        expect(mockSearchAll).not.toHaveBeenCalled();
        expect(mockSearchByType).not.toHaveBeenCalled();
    });

    it("returns 500 when search service throws", async () => {
        mockSearchByType.mockRejectedValueOnce(new Error("search down"));
        const req = {
            query: { q: "jazz", type: "albums", limit: "abc" },
        } as any;
        const res = createRes();

        await rootHandler(req, res);

        expect(mockSearchByType).toHaveBeenCalledWith({
            query: "jazz",
            type: "albums",
            limit: 20,
            offset: 0,
            genre: undefined,
        });
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Search failed" });
    });

    it("returns empty and visible genres while hiding all-removed genres", async () => {
        mockGenreFindMany.mockResolvedValueOnce([
            { id: "genre-empty", name: "Ambient", _count: { trackGenres: 0 } },
            { id: "genre-mixed", name: "Rock", _count: { trackGenres: 5 } },
        ]);

        const req = {} as any;
        const res = createRes();
        await genresHandler(req, res);

        expect(mockGenreFindMany).toHaveBeenCalledWith({
            where: {
                OR: [
                    { trackGenres: { none: {} } },
                    {
                        trackGenres: {
                            some: { track: { removedAt: null } },
                        },
                    },
                ],
            },
            orderBy: { name: "asc" },
            include: {
                _count: {
                    select: {
                        trackGenres: {
                            where: { track: { removedAt: null } },
                        },
                    },
                },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            { id: "genre-empty", name: "Ambient", trackCount: 0 },
            { id: "genre-mixed", name: "Rock", trackCount: 5 },
        ]);
        expect(res.body).not.toContainEqual(
            expect.objectContaining({ id: "genre-all-removed" }),
        );
    });

    it("returns 500 when genre lookup fails", async () => {
        mockGenreFindMany.mockRejectedValueOnce(new Error("db error"));
        const req = {} as any;
        const res = createRes();

        await genresHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get genres" });
    });

    it("returns empty discover payload for blank query", async () => {
        const req = { query: { q: "   " } } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ results: [], aliasInfo: null });
    });

    it("returns cached discover payload when available", async () => {
        const cached = {
            results: [{ type: "music", id: "artist-1", name: "Cached Artist" }],
            aliasInfo: null,
        };
        mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

        const req = {
            query: { q: "cached", type: "music", limit: "5" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(cached);
        expect(mockSearchArtists).not.toHaveBeenCalled();
        expect(mockYtMusicSearch).not.toHaveBeenCalled();
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("builds discover payload with alias correction and podcast mapping", async () => {
        mockGetArtistCorrection.mockResolvedValueOnce({
            corrected: true,
            canonicalName: "Radiohead",
            mbid: "mbid-radiohead",
        });
        mockSearchArtists.mockResolvedValueOnce([
            {
                type: "music",
                id: "artist-1",
                name: "Radiohead",
            },
        ]);
        mockSearchTracks.mockResolvedValueOnce([
            { type: "track", id: "track-1", name: "Paranoid Android" },
        ]);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                results: [
                    {
                        collectionId: 55,
                        collectionName: "Podcast A",
                        artistName: "Host A",
                        description: "Desc",
                        artworkUrl600: "large.jpg",
                        artworkUrl100: "small.jpg",
                        feedUrl: "https://example.com/feed.xml",
                        genres: ["Music"],
                        trackCount: 42,
                    },
                ],
            },
        });

        const req = {
            query: { q: "  rh ", type: "all", limit: "60" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(mockSearchArtists).toHaveBeenCalledWith("Radiohead", 50);
        expect(mockSearchTracks).toHaveBeenCalledWith("Radiohead", 60);
        expect(mockYtMusicSearch).toHaveBeenCalledWith(
            "__public__",
            "Radiohead",
            "songs",
            60,
            { timeoutMs: 8_000, maxRetries: 0 },
        );
        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://itunes.apple.com/search",
            expect.objectContaining({
                params: {
                    term: "rh",
                    media: "podcast",
                    entity: "podcast",
                    limit: 60,
                },
                timeout: 5000,
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.aliasInfo).toEqual({
            original: "rh",
            canonical: "Radiohead",
            mbid: "mbid-radiohead",
        });
        expect(res.body.results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ type: "music", name: "Radiohead" }),
                expect.objectContaining({ type: "track", id: "track-1" }),
                expect.objectContaining({
                    type: "podcast",
                    id: 55,
                    name: "Podcast A",
                    coverUrl: "large.jpg",
                }),
            ]),
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "search:discover:v8:yt1:lf1:all:rh:60",
            900,
            expect.any(String),
        );
    });

    it("merges exact YouTube Music identities into Last.fm tracks and deduplicates provider results", async () => {
        mockSearchTracks.mockResolvedValueOnce([
            {
                type: "track",
                id: "lastfm-paranoid-android",
                name: "Paranoid-Android",
                artist: "Rádïóhead",
                album: "OK Computer",
                listeners: 123,
                image: null,
            },
            {
                type: "track",
                id: "lastfm-paranoid-duplicate",
                name: "Paranoid Android",
                artist: "Radiohead",
                album: "OK Computer",
                image: null,
            },
        ]);
        mockYtMusicSearch.mockResolvedValueOnce({
            query: "radiohead",
            filter: "songs",
            total: 4,
            results: [
                {
                    source: "youtube",
                    provider: "ytmusic",
                    providerTrackId: "video-paranoid",
                    title: "  paranoid android  ",
                    artistName: "RADIOHEAD",
                    albumTitle: "OK Computer",
                    durationSec: 387,
                    thumbnailUrl: "paranoid.jpg",
                    raw: {},
                },
                {
                    source: "youtube",
                    provider: "ytmusic",
                    providerTrackId: "video-paranoid-live",
                    title: "Paranoid Android",
                    artistName: "Radiohead",
                    albumTitle: "I Might Be Wrong: Live Recordings",
                    durationSec: 401,
                    thumbnailUrl: "paranoid-live.jpg",
                    raw: {},
                },
                {
                    source: "youtube",
                    provider: "ytmusic",
                    providerTrackId: "video-karma",
                    title: "Karma Police",
                    artistName: "Radiohead",
                    albumTitle: "OK Computer",
                    durationSec: 264,
                    thumbnailUrl: "karma.jpg",
                    raw: {},
                },
                {
                    source: "youtube",
                    provider: "ytmusic",
                    providerTrackId: "video-karma",
                    title: "Karma Police (duplicate provider row)",
                    artistName: "Radiohead",
                    albumTitle: null,
                    durationSec: 264,
                    thumbnailUrl: null,
                    raw: {},
                },
            ],
        });

        const req = {
            query: { q: "radiohead", type: "music", limit: "20" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toEqual([
            {
                type: "track",
                id: "lastfm-paranoid-android",
                name: "Paranoid-Android",
                artist: "Rádïóhead",
                album: "OK Computer",
                listeners: 123,
                image: "paranoid.jpg",
                providerTrackId: "video-paranoid",
                streamSource: "youtube",
                youtubeVideoId: "video-paranoid",
                duration: 387,
            },
            {
                type: "track",
                id: "video-paranoid-live",
                name: "Paranoid Android",
                artist: "Radiohead",
                album: "I Might Be Wrong: Live Recordings",
                image: "paranoid-live.jpg",
                providerTrackId: "video-paranoid-live",
                streamSource: "youtube",
                youtubeVideoId: "video-paranoid-live",
                duration: 401,
            },
            {
                type: "track",
                id: "video-karma",
                name: "Karma Police",
                artist: "Radiohead",
                album: "OK Computer",
                image: "karma.jpg",
                providerTrackId: "video-karma",
                streamSource: "youtube",
                youtubeVideoId: "video-karma",
                duration: 264,
            },
        ]);
    });

    it("returns directly playable YouTube Music tracks when Last.fm has no catalog results", async () => {
        mockSearchTracks.mockResolvedValueOnce([]);
        mockYtMusicSearch.mockResolvedValueOnce({
            query: "rare song",
            filter: "songs",
            total: 1,
            results: [
                {
                    source: "youtube",
                    provider: "ytmusic",
                    providerTrackId: "rare-video-id",
                    title: "Rare Song",
                    artistName: "Rare Artist",
                    albumTitle: null,
                    durationSec: null,
                    thumbnailUrl: null,
                    raw: {},
                },
            ],
        });

        const req = {
            query: { q: "rare song", type: "music", limit: "5" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toEqual([
            expect.objectContaining({
                type: "track",
                id: "rare-video-id",
                providerTrackId: "rare-video-id",
                youtubeVideoId: "rare-video-id",
                streamSource: "youtube",
            }),
        ]);
    });

    it("skips unconfigured Last.fm and caches the complete YouTube Music catalog result", async () => {
        mockIsLastFmConfigured.mockResolvedValueOnce(false);
        mockYtMusicSearch.mockResolvedValueOnce({
            query: "linkin park",
            filter: "songs",
            total: 1,
            results: [
                {
                    source: "youtube",
                    provider: "ytmusic",
                    providerTrackId: "numb-video",
                    title: "Numb",
                    artistName: "Linkin Park",
                    albumTitle: "Meteora",
                    durationSec: 185,
                    thumbnailUrl: null,
                    raw: {},
                },
            ],
        });
        const res = createRes();

        await discoverHandler(
            {
                query: { q: "linkin park", type: "music", limit: "20" },
            } as any,
            res,
        );

        expect(mockGetArtistCorrection).not.toHaveBeenCalled();
        expect(mockSearchArtists).not.toHaveBeenCalled();
        expect(mockSearchTracks).not.toHaveBeenCalled();
        expect(res.body.results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    youtubeVideoId: "numb-video",
                    name: "Numb",
                }),
            ]),
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "search:discover:v8:yt1:lf0:music:linkin park:20",
            900,
            expect.any(String),
        );
    });

    it("returns generic YouTube Music tracks, albums, and artists without duplicate artist rows", async () => {
        mockSearchArtists.mockResolvedValueOnce([
            {
                type: "music",
                id: "lastfm-massive-attack",
                mbid: "mbid-massive-attack",
                name: "Massive Attack",
                image: null,
            },
        ]);
        mockYtMusicSearch.mockResolvedValueOnce({
            query: "massive attack",
            filter: "songs",
            total: 1,
            results: [
                {
                    source: "youtube",
                    provider: "ytmusic",
                    providerTrackId: "teardrop-video",
                    title: "Teardrop",
                    artistName: "Massive Attack",
                    albumTitle: "Mezzanine",
                    durationSec: 331,
                    thumbnailUrl: "https://img/teardrop.jpg",
                    raw: {},
                },
            ],
        });
        mockYtMusicCatalogSearch.mockImplementation(
            async (
                _userId: string,
                query: string,
                filter: "albums" | "artists",
            ) => {
                if (filter === "albums") {
                    return {
                        query,
                        filter,
                        total: 2,
                        results: [
                            {
                                mediaType: "album",
                                provider: "ytmusic",
                                browseId: "MPREb_mezzanine",
                                title: "Mezzanine",
                                artistName: "Massive Attack",
                                year: "1998",
                                thumbnailUrl: "https://img/mezzanine.jpg",
                                raw: {},
                            },
                            {
                                mediaType: "album",
                                provider: "ytmusic",
                                browseId: "MPREb_mezzanine",
                                title: "Mezzanine duplicate",
                                artistName: "Massive Attack",
                                year: "1998",
                                thumbnailUrl: null,
                                raw: {},
                            },
                        ],
                    };
                }
                return {
                    query,
                    filter,
                    total: 2,
                    results: [
                        {
                            mediaType: "artist",
                            provider: "ytmusic",
                            channelId: "UCmassiveattack",
                            name: "Massive Attack",
                            thumbnailUrl: "https://img/massive-attack.jpg",
                            raw: {},
                        },
                        {
                            mediaType: "artist",
                            provider: "ytmusic",
                            channelId: "UCmassiveattackremix",
                            name: "Massive Attack Remix",
                            thumbnailUrl: null,
                            raw: {},
                        },
                    ],
                };
            },
        );

        const req = {
            query: { q: "massive attack", type: "music", limit: "20" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockYtMusicSearch).toHaveBeenCalledWith(
            "__public__",
            "massive attack",
            "songs",
            20,
            { timeoutMs: 8_000, maxRetries: 0 },
        );
        expect(mockYtMusicCatalogSearch).toHaveBeenCalledWith(
            "__public__",
            "massive attack",
            "albums",
            20,
            { timeoutMs: 8_000, maxRetries: 0 },
        );
        expect(mockYtMusicCatalogSearch).toHaveBeenCalledWith(
            "__public__",
            "massive attack",
            "artists",
            20,
            { timeoutMs: 8_000, maxRetries: 0 },
        );
        expect(res.body.results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "track",
                    name: "Teardrop",
                    youtubeVideoId: "teardrop-video",
                }),
                {
                    type: "album",
                    id: "MPREb_mezzanine",
                    browseId: "MPREb_mezzanine",
                    name: "Mezzanine",
                    artist: "Massive Attack",
                    image: "https://img/mezzanine.jpg",
                    year: "1998",
                    provider: "ytmusic",
                },
                {
                    type: "music",
                    id: "lastfm-massive-attack",
                    mbid: "mbid-massive-attack",
                    name: "Massive Attack",
                    image: "https://img/massive-attack.jpg",
                    provider: "ytmusic",
                    youtubeChannelId: "UCmassiveattack",
                },
                {
                    type: "music",
                    id: "UCmassiveattackremix",
                    name: "Massive Attack Remix",
                    image: null,
                    provider: "ytmusic",
                    youtubeChannelId: "UCmassiveattackremix",
                },
            ]),
        );
        expect(
            res.body.results.filter(
                (result: { type: string; name: string }) =>
                    result.type === "music" && result.name === "Massive Attack",
            ),
        ).toHaveLength(1);
        expect(
            res.body.results.filter(
                (result: { type: string }) => result.type === "album",
            ),
        ).toHaveLength(1);
    });

    it("merges Last.fm and YouTube Music artist spellings that differ only by diacritics", async () => {
        mockSearchArtists.mockResolvedValueOnce([
            {
                type: "music",
                id: "lastfm-bjork",
                mbid: "mbid-bjork",
                name: "Björk",
                image: null,
            },
            {
                type: "music",
                id: "lastfm-bjork-duplicate",
                name: "Bjork",
                image: null,
            },
        ]);
        mockYtMusicCatalogSearch.mockImplementation(
            async (
                _userId: string,
                query: string,
                filter: "albums" | "artists",
            ) => ({
                query,
                filter,
                total: filter === "artists" ? 1 : 0,
                results:
                    filter === "artists"
                        ? [
                              {
                                  mediaType: "artist",
                                  provider: "ytmusic",
                                  channelId: "UCbjork",
                                  name: "Bjork",
                                  thumbnailUrl: "https://img/bjork.jpg",
                                  raw: {},
                              },
                          ]
                        : [],
            }),
        );

        const req = {
            query: { q: "bjork", type: "music", limit: "20" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(
            res.body.results.filter(
                (result: { type: string; name: string }) =>
                    result.type === "music" &&
                    result.name
                        .normalize("NFD")
                        .replace(/[\u0300-\u036f]/g, "")
                        .toLowerCase() === "bjork",
            ),
        ).toEqual([
            {
                type: "music",
                id: "lastfm-bjork",
                mbid: "mbid-bjork",
                name: "Björk",
                image: "https://img/bjork.jpg",
                provider: "ytmusic",
                youtubeChannelId: "UCbjork",
            },
        ]);
    });

    it("retains a YouTube Music artist identity when a local artist has the same normalized name", async () => {
        mockArtistFindMany.mockResolvedValueOnce([
            { name: "Björk", normalizedName: "bjork" },
        ]);
        mockYtMusicCatalogSearch.mockImplementation(
            async (
                _userId: string,
                query: string,
                filter: "albums" | "artists",
            ) => ({
                query,
                filter,
                total: filter === "artists" ? 1 : 0,
                results:
                    filter === "artists"
                        ? [
                              {
                                  mediaType: "artist",
                                  provider: "ytmusic",
                                  channelId: "UCbjork",
                                  name: "Bjork",
                                  thumbnailUrl: "https://img/bjork.jpg",
                                  raw: {},
                              },
                          ]
                        : [],
            }),
        );

        const req = {
            query: { q: "bjork", type: "music", limit: "20" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(mockArtistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    OR: expect.arrayContaining([
                        { normalizedName: { in: ["bjork"] } },
                    ]),
                },
            }),
        );
        expect(
            res.body.results.filter(
                (result: { type: string }) => result.type === "music",
            ),
        ).toEqual([
            {
                type: "music",
                id: "UCbjork",
                name: "Bjork",
                image: "https://img/bjork.jpg",
                provider: "ytmusic",
                youtubeChannelId: "UCbjork",
            },
        ]);
    });

    it("returns ready metadata when a YouTube Music source exceeds the discovery deadline", async () => {
        jest.useFakeTimers();
        mockSearchTracks.mockResolvedValueOnce([
            {
                type: "track",
                id: "lastfm-ready",
                name: "Ready Track",
                artist: "Ready Artist",
            },
        ]);
        mockYtMusicSearch.mockImplementationOnce(
            () => new Promise(() => undefined),
        );

        const req = {
            query: { q: "ready artist", type: "music", limit: "5" },
        } as any;
        const res = createRes();
        const responsePromise = discoverHandler(req, res);

        await jest.advanceTimersByTimeAsync(9_000);
        await responsePromise;

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: "lastfm-ready" }),
            ]),
        );
        expect(mockRedisSetEx).not.toHaveBeenCalled();
        jest.useRealTimers();
    });

    it("ranks concise artist matches ahead of long-form video-style rows", async () => {
        mockYtMusicSearch.mockResolvedValueOnce({
            query: "linkin park",
            filter: "songs",
            total: 2,
            results: [
                {
                    source: "youtube",
                    provider: "ytmusic",
                    providerTrackId: "long-video",
                    title: "LINKIN PARK: Full Album",
                    artistName: "Uploader Channel",
                    albumTitle: null,
                    durationSec: 4_200,
                    thumbnailUrl: null,
                    raw: {},
                },
                {
                    source: "youtube",
                    provider: "ytmusic",
                    providerTrackId: "numb-video",
                    title: "Numb",
                    artistName: "Linkin Park",
                    albumTitle: "Meteora",
                    durationSec: 185,
                    thumbnailUrl: null,
                    raw: {},
                },
            ],
        });

        const req = {
            query: { q: "linkin park", type: "music", limit: "50" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(mockYtMusicSearch).toHaveBeenCalledWith(
            "__public__",
            "linkin park",
            "songs",
            50,
            { timeoutMs: 8_000, maxRetries: 0 },
        );
        expect(
            res.body.results
                .filter((result: { type: string }) => result.type === "track")
                .map((result: { name: string }) => result.name),
        ).toEqual(["Numb", "LINKIN PARK: Full Album"]);
    });

    it("requests a provider continuation prefix beyond fifty and advertises only a proven next step", async () => {
        mockYtMusicSearch.mockResolvedValueOnce({
            query: "linkin park",
            filter: "songs",
            total: 100,
            results: Array.from({ length: 100 }, (_, index) => ({
                source: "youtube",
                provider: "ytmusic",
                providerTrackId: `video-${index}`,
                title: `Track ${index}`,
                artistName: "Linkin Park",
                albumTitle: null,
                durationSec: 180,
                thumbnailUrl: null,
                raw: {},
            })),
        });

        const res = createRes();
        await discoverHandler(
            {
                query: { q: "linkin park", type: "music", limit: "100" },
            } as any,
            res,
        );

        expect(mockYtMusicSearch).toHaveBeenCalledWith(
            "__public__",
            "linkin park",
            "songs",
            100,
            { timeoutMs: 8_000, maxRetries: 0 },
        );
        expect(
            res.body.results.filter(
                (result: { type: string }) => result.type === "track",
            ),
        ).toHaveLength(100);
        expect(res.body.pageInfo).toEqual({
            requestedLimit: 100,
            canRequestMoreTracks: true,
        });
    });

    it("does not query YouTube Music when the integration is disabled", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            ytMusicEnabled: false,
        });
        mockIsLastFmConfigured.mockResolvedValueOnce(false);
        mockRedisGet.mockImplementationOnce(async (key: string) =>
            key.includes(":yt1:lf1:")
                ? JSON.stringify({
                      results: [
                          {
                              type: "track",
                              id: "stale-video",
                              name: "Stale enabled result",
                              streamSource: "youtube",
                              youtubeVideoId: "stale-video",
                          },
                      ],
                      aliasInfo: null,
                  })
                : null,
        );

        const req = {
            query: { q: "radiohead", type: "music", limit: "5" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockYtMusicSearch).not.toHaveBeenCalled();
        expect(mockRedisGet).toHaveBeenCalledWith(
            "search:discover:v8:yt0:lf0:music:radiohead:5",
        );
        expect(res.body.results).toEqual([]);
    });

    it("preserves Last.fm results when the YouTube Music settings check fails", async () => {
        mockGetSystemSettings.mockRejectedValueOnce(
            new Error("settings unavailable"),
        );
        mockSearchTracks.mockResolvedValueOnce([
            {
                type: "track",
                id: "lastfm-only",
                name: "Last.fm Result",
                artist: "Metadata Artist",
            },
        ]);

        const req = {
            query: { q: "metadata", type: "music", limit: "5" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockYtMusicSearch).not.toHaveBeenCalled();
        expect(res.body.results).toEqual([
            expect.objectContaining({ id: "lastfm-only" }),
        ]);
    });

    it("preserves Last.fm results when the public YouTube Music search fails", async () => {
        mockSearchTracks.mockResolvedValueOnce([
            {
                type: "track",
                id: "lastfm-fallback",
                name: "Metadata Fallback",
                artist: "Metadata Artist",
            },
        ]);
        mockYtMusicSearch.mockRejectedValueOnce(
            new Error("sidecar unavailable"),
        );

        const req = {
            query: { q: "metadata", type: "music", limit: "5" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toEqual([
            expect.objectContaining({ id: "lastfm-fallback" }),
        ]);
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("handles discover partial failures and redis write errors", async () => {
        mockRedisGet.mockRejectedValueOnce(new Error("redis read fail"));
        mockGetArtistCorrection.mockRejectedValueOnce(
            new Error("lastfm correction fail"),
        );
        mockSearchArtists.mockRejectedValueOnce(
            new Error("artist search fail"),
        );
        mockSearchTracks.mockResolvedValueOnce([
            { type: "track", id: "track-2", name: "Song B" },
        ]);
        mockRedisSetEx.mockRejectedValueOnce(new Error("redis write fail"));

        const req = {
            query: { q: "radiohead", type: "music", limit: "2" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            results: [{ type: "track", id: "track-2", name: "Song B" }],
            aliasInfo: null,
        });
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("skips library lookup when discovered artists have no usable names", async () => {
        mockSearchArtists.mockResolvedValueOnce([
            { type: "music", id: "x", name: 42 },
        ]);
        const req = { query: { q: "odd", type: "music", limit: "3" } } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(mockArtistFindMany).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.results).toEqual([
            { type: "music", id: "x", name: 42 },
        ]);
    });

    it("falls back to live discover fetch when cached payload is malformed", async () => {
        mockRedisGet.mockResolvedValueOnce("not valid json");
        mockSearchTracks.mockResolvedValueOnce([
            { type: "track", id: "track-live", name: "Live Result" },
        ]);
        const req = {
            query: { q: "broken", type: "music", limit: "5" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            results: [{ type: "track", id: "track-live", name: "Live Result" }],
            aliasInfo: null,
        });
    });

    it("returns 500 when artist filtering lookup throws during discover", async () => {
        mockSearchArtists.mockResolvedValueOnce([
            { type: "music", id: "artist-err", name: "Boom Artist" },
        ]);
        mockArtistFindMany.mockRejectedValueOnce(new Error("db failure"));
        const req = { query: { q: "boom", type: "music", limit: "4" } } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Discovery search failed" });
    });

    it("returns empty similar artists when no seed artist is supplied", async () => {
        const req = { query: { artist: "   " } } as any;
        const res = createRes();

        await discoverSimilarHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ similarArtists: [] });
        expect(mockGetSimilarArtists).not.toHaveBeenCalled();
    });

    it("returns cached similar artists payload", async () => {
        const cached = {
            similarArtists: [{ id: "cached-1", name: "Cached Similar" }],
        };
        mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

        const req = {
            query: { artist: "Radiohead", mbid: "mbid-r", limit: "9" },
        } as any;
        const res = createRes();

        await discoverSimilarHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(cached);
        expect(mockGetSimilarArtists).not.toHaveBeenCalled();
    });

    it("fetches and enriches similar artists with bounded limits", async () => {
        mockRedisGet.mockRejectedValueOnce(new Error("read fail"));
        mockGetSimilarArtists.mockResolvedValueOnce([
            { name: "Thom Yorke", match: 0.92 },
            { name: "Atoms for Peace", match: 0.74 },
        ]);
        mockEnrichSimilarArtists.mockResolvedValueOnce([
            { id: "sim-1", name: "Thom Yorke" },
            { id: "sim-2", name: "Atoms for Peace" },
        ]);
        mockRedisSetEx.mockRejectedValueOnce(new Error("write fail"));

        const req = {
            query: { artist: "Radiohead", mbid: "mbid-r", limit: "100" },
        } as any;
        const res = createRes();

        await discoverSimilarHandler(req, res);

        expect(mockGetSimilarArtists).toHaveBeenCalledWith(
            "mbid-r",
            "Radiohead",
            100,
        );
        expect(mockEnrichSimilarArtists).toHaveBeenCalledWith(
            [
                { name: "Thom Yorke", match: 0.92 },
                { name: "Atoms for Peace", match: 0.74 },
            ],
            50,
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            similarArtists: [
                { id: "sim-1", name: "Thom Yorke" },
                { id: "sim-2", name: "Atoms for Peace" },
            ],
        });
    });

    it("falls back to local similar-artist graph when Last.fm enrichment is empty", async () => {
        mockGetSimilarArtists.mockResolvedValueOnce([
            { name: "Sparse Similar", match: 0.64 },
        ]);
        mockEnrichSimilarArtists.mockResolvedValueOnce([]);
        mockArtistFindFirst.mockResolvedValueOnce({ id: "artist-seed-1" });
        mockSimilarArtistFindMany.mockResolvedValueOnce([
            {
                weight: 0.98,
                toArtist: {
                    id: "artist-2",
                    mbid: "mbid-thom",
                    name: "Thom Yorke",
                    heroUrl: "thom.jpg",
                    summary: "Radiohead side projects and solo work",
                    genres: ["alternative", "electronic"],
                },
            },
            {
                weight: 0.87,
                toArtist: {
                    id: "artist-3",
                    mbid: "mbid-atoms",
                    name: "Atoms for Peace",
                    heroUrl: null,
                    summary: null,
                    genres: null,
                },
            },
        ]);

        const req = {
            query: { artist: "Radiohead", mbid: "mbid-r", limit: "2" },
        } as any;
        const res = createRes();

        await discoverSimilarHandler(req, res);

        expect(mockGetSimilarArtists).toHaveBeenCalledWith(
            "mbid-r",
            "Radiohead",
            10,
        );
        expect(mockEnrichSimilarArtists).toHaveBeenCalledWith(
            [{ name: "Sparse Similar", match: 0.64 }],
            2,
        );
        expect(mockArtistFindFirst).toHaveBeenCalledWith({
            where: {
                OR: [
                    { name: { equals: "Radiohead", mode: "insensitive" } },
                    { normalizedName: "radiohead" },
                    { mbid: "mbid-r" },
                ],
            },
            select: { id: true },
        });
        expect(mockSimilarArtistFindMany).toHaveBeenCalledWith({
            where: { fromArtistId: "artist-seed-1" },
            orderBy: { weight: "desc" },
            take: 2,
            include: {
                toArtist: {
                    select: {
                        id: true,
                        mbid: true,
                        name: true,
                        heroUrl: true,
                        summary: true,
                        genres: true,
                    },
                },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            similarArtists: [
                {
                    type: "music",
                    id: "mbid-thom",
                    name: "Thom Yorke",
                    listeners: 0,
                    url: null,
                    image: "thom.jpg",
                    mbid: "mbid-thom",
                    bio: "Radiohead side projects and solo work",
                    tags: ["alternative", "electronic"],
                },
                {
                    type: "music",
                    id: "mbid-atoms",
                    name: "Atoms for Peace",
                    listeners: 0,
                    url: null,
                    image: null,
                    mbid: "mbid-atoms",
                    bio: null,
                    tags: [],
                },
            ],
        });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "search:discover:similar:radiohead:mbid-r:2",
            3600,
            expect.any(String),
        );
    });

    it("returns empty similar artists when no similar seed results exist", async () => {
        mockGetSimilarArtists.mockResolvedValueOnce([]);
        const req = {
            query: { artist: "NoMatch", mbid: "", limit: "5" },
        } as any;
        const res = createRes();

        await discoverSimilarHandler(req, res);

        expect(mockEnrichSimilarArtists).not.toHaveBeenCalled();
        expect(mockArtistFindFirst).toHaveBeenCalledWith({
            where: {
                OR: [
                    { name: { equals: "NoMatch", mode: "insensitive" } },
                    { normalizedName: "nomatch" },
                ],
            },
            select: { id: true },
        });
        expect(mockSimilarArtistFindMany).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ similarArtists: [] });
    });

    it("returns 500 when similar artist search throws", async () => {
        mockGetSimilarArtists.mockRejectedValueOnce(
            new Error("lastfm unavailable"),
        );
        const req = {
            query: { artist: "Radiohead", mbid: "mbid", limit: "6" },
        } as any;
        const res = createRes();

        await discoverSimilarHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Similar artists search failed" });
    });
});
