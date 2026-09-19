import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const AUTH_HEADER = "x-test-auth";
const AUTH_VALUE = "ok";

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: Request, res: Response, next: NextFunction) => {
        if (req.header(AUTH_HEADER) !== AUTH_VALUE) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        req.user = {
            id: "user-1",
            username: "tester",
            role: "user",
        };
        next();
    },
}));

jest.mock("../../middleware/rateLimiter", () => ({
    imageLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn().mockReturnThis(),
    },
}));

const deezerService = {
    parseUrl: jest.fn(),
};
jest.mock("../../services/deezer", () => ({
    deezerService,
}));

const spotifyService = {
    parseUrl: jest.fn(),
};
jest.mock("../../services/spotify", () => ({
    spotifyService,
}));

const ytMusicService = {
    getCharts: jest.fn(),
    getMoodCategories: jest.fn(),
    getHome: jest.fn(),
    getMoodPlaylists: jest.fn(),
    getBrowsePlaylist: jest.fn(),
    getBrowseAlbum: jest.fn(),
    getLibraryPlaylists: jest.fn(),
};
jest.mock("../../services/youtubeMusic", () => ({
    ytMusicService,
}));

const browseImageCacheKey = jest.fn((url: string) => `cache:${url}`);
const getBrowseImageFromCache = jest.fn();
const fetchAndCacheBrowseImage = jest.fn();
jest.mock("../../services/browseImageCache", () => ({
    getBrowseImageCacheRoot: () => "/tmp",
    browseImageCacheKey,
    getBrowseImageFromCache,
    fetchAndCacheBrowseImage,
}));

const mockGetSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: unknown[]) => mockGetSystemSettings(...args),
}));

jest.mock("../../config", () => ({ config: { ytmusicRegion: "US" } }));

import router, { _resetYtBrowseCache } from "../browse";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/browse", router);

function makeTempImagePath(): string {
    const filePath = path.join(
        os.tmpdir(),
        `browse-branch-${Date.now()}-${Math.random()}.img`,
    );
    fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff]));
    return filePath;
}

describe("browse branch coverage", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _resetYtBrowseCache();

        mockGetSystemSettings.mockResolvedValue({ ytMusicEnabled: true });
        deezerService.parseUrl.mockReturnValue(null);
        spotifyService.parseUrl.mockReturnValue(null);

        ytMusicService.getCharts.mockResolvedValue([]);
        ytMusicService.getMoodCategories.mockResolvedValue([]);
        ytMusicService.getHome.mockResolvedValue([]);
        ytMusicService.getMoodPlaylists.mockResolvedValue([]);
        ytMusicService.getBrowsePlaylist.mockResolvedValue({
            id: "pl-1",
            tracks: [],
        });
        ytMusicService.getBrowseAlbum.mockResolvedValue({
            title: "album",
            artist: "artist",
            year: "2024",
            trackCount: 0,
            coverUrl: null,
            tracks: [],
        });
        ytMusicService.getLibraryPlaylists.mockResolvedValue([]);

        getBrowseImageFromCache.mockReturnValue(null);
        fetchAndCacheBrowseImage.mockResolvedValue(null);
    });

    describe("POST /api/browse/playlists/parse", () => {
        it("parses deezer URL without scheme via candidate normalization", async () => {
            deezerService.parseUrl.mockReturnValueOnce({
                type: "playlist",
                id: "dz-no-scheme",
            });

            const res = await request(app)
                .post("/api/browse/playlists/parse")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: "deezer.com/playlist/dz-no-scheme" });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                source: "deezer",
                type: "playlist",
                id: "dz-no-scheme",
                url: "https://www.deezer.com/playlist/dz-no-scheme",
            });
        });

        it("supports play.spotify.com host and ignores non-playlist parse results", async () => {
            spotifyService.parseUrl.mockReturnValueOnce({
                type: "album",
                id: "album-1",
            });

            const res = await request(app)
                .post("/api/browse/playlists/parse")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: "https://play.spotify.com/album/album-1" });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/unsupported/i);
        });

        it("rejects explicit non-http scheme that fails URL parsing", async () => {
            const res = await request(app)
                .post("/api/browse/playlists/parse")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: "bad-scheme:??::" });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/unsupported/i);
        });

        it("rejects youtube playlist URL with invalid list id characters", async () => {
            const res = await request(app)
                .post("/api/browse/playlists/parse")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({
                    url: "https://music.youtube.com/playlist?list=BAD!ID",
                });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/unsupported/i);
        });
    });

    describe("image proxy/cache branches", () => {
        it("validates required and allowed host checks for ytmusic image", async () => {
            const missing = await request(app)
                .get("/api/browse/ytmusic/image")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(missing.status).toBe(400);
            expect(missing.body).toEqual({
                error: "url query parameter is required",
            });

            const invalid = await request(app)
                .get("/api/browse/ytmusic/image?url=this-is-not-a-url")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(invalid.status).toBe(400);
            expect(invalid.body).toEqual({ error: "Invalid URL" });

            const disallowed = await request(app)
                .get(
                    "/api/browse/ytmusic/image?url=https://example.com/nope.jpg",
                )
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(disallowed.status).toBe(400);
            expect(disallowed.body).toEqual({ error: "URL host not allowed" });
        });

        it("fetches and serves ytmusic image on cache miss", async () => {
            const filePath = makeTempImagePath();
            fetchAndCacheBrowseImage.mockResolvedValueOnce({
                filePath,
                contentType: "image/jpeg",
            });

            try {
                const res = await request(app)
                    .get(
                        "/api/browse/ytmusic/image?url=https://i.ytimg.com/vi/xyz/default.jpg",
                    )
                    .set(AUTH_HEADER, AUTH_VALUE);

                expect(res.status).toBe(200);
            } finally {
                fs.rmSync(filePath, { force: true });
            }
        });

        it("serves cached ytmusic image without fetch", async () => {
            const filePath = makeTempImagePath();
            getBrowseImageFromCache.mockReturnValueOnce({
                filePath,
                contentType: "image/webp",
            });

            try {
                const res = await request(app)
                    .get(
                        "/api/browse/ytmusic/image?url=https://i.ytimg.com/vi/abc/default.jpg",
                    )
                    .set(AUTH_HEADER, AUTH_VALUE);

                expect(res.status).toBe(200);
                expect(fetchAndCacheBrowseImage).not.toHaveBeenCalled();
            } finally {
                fs.rmSync(filePath, { force: true });
            }
        });

        it("returns 404 when ytmusic image fetch misses", async () => {
            const res = await request(app)
                .get(
                    "/api/browse/ytmusic/image?url=https://lh3.googleusercontent.com/x",
                )
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(404);
            expect(res.body).toEqual({ error: "Failed to fetch image" });
        });
    });

    describe("ytmusic availability and error branches", () => {
        it("returns 403 when ytmusic integration is disabled", async () => {
            mockGetSystemSettings.mockResolvedValueOnce({
                ytMusicEnabled: false,
            });

            const res = await request(app)
                .get("/api/browse/ytmusic/charts")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/not enabled/i);
        });

        it("maps ytmusic home 4xx errors without detail to fallback message", async () => {
            ytMusicService.getHome.mockRejectedValueOnce({
                response: { status: 429, data: { detail: { nested: true } } },
            });

            const res = await request(app)
                .get("/api/browse/ytmusic/home")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(429);
            expect(res.body).toEqual({
                error: "Invalid request for home content",
            });
        });

        it("returns 500 for ytmusic charts failures", async () => {
            ytMusicService.getCharts.mockRejectedValueOnce(
                new Error("charts down"),
            );

            const res = await request(app)
                .get("/api/browse/ytmusic/charts")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ error: "Failed to fetch charts" });
        });

        it("returns cached ytmusic charts on second request", async () => {
            ytMusicService.getCharts.mockResolvedValue([{ title: "top" }]);

            const first = await request(app)
                .get("/api/browse/ytmusic/charts?country=US")
                .set(AUTH_HEADER, AUTH_VALUE);
            const second = await request(app)
                .get("/api/browse/ytmusic/charts?country=US")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(ytMusicService.getCharts).toHaveBeenCalledTimes(1);
        });

        it("covers ytmusic categories disabled, cached, and 500 branches", async () => {
            mockGetSystemSettings.mockResolvedValueOnce({
                ytMusicEnabled: false,
            });
            const disabled = await request(app)
                .get("/api/browse/ytmusic/categories")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(disabled.status).toBe(403);

            ytMusicService.getMoodCategories.mockResolvedValue([
                { title: "Focus", params: "f" },
            ]);
            const first = await request(app)
                .get("/api/browse/ytmusic/categories")
                .set(AUTH_HEADER, AUTH_VALUE);
            const cached = await request(app)
                .get("/api/browse/ytmusic/categories")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(first.status).toBe(200);
            expect(cached.status).toBe(200);
            expect(ytMusicService.getMoodCategories).toHaveBeenCalledTimes(1);

            _resetYtBrowseCache();
            ytMusicService.getMoodCategories.mockRejectedValueOnce(
                new Error("categories down"),
            );
            const failing = await request(app)
                .get("/api/browse/ytmusic/categories")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(failing.status).toBe(500);
            expect(failing.body).toEqual({
                error: "Failed to fetch categories",
            });
        });

        it("covers ytmusic home disabled, cached, and generic 500 branches", async () => {
            mockGetSystemSettings.mockResolvedValueOnce({
                ytMusicEnabled: false,
            });
            const disabled = await request(app)
                .get("/api/browse/ytmusic/home")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(disabled.status).toBe(403);

            ytMusicService.getHome.mockResolvedValue([
                { title: "For You", contents: [] },
            ]);
            const first = await request(app)
                .get("/api/browse/ytmusic/home?limit=6")
                .set(AUTH_HEADER, AUTH_VALUE);
            const cached = await request(app)
                .get("/api/browse/ytmusic/home?limit=6")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(first.status).toBe(200);
            expect(cached.status).toBe(200);
            expect(ytMusicService.getHome).toHaveBeenCalledTimes(1);

            _resetYtBrowseCache();
            ytMusicService.getHome.mockRejectedValueOnce(
                new Error("home down"),
            );
            const failing = await request(app)
                .get("/api/browse/ytmusic/home")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(failing.status).toBe(500);
            expect(failing.body).toEqual({
                error: "Failed to fetch home content",
            });
        });

        it("rejects overly long ytmusic mood params", async () => {
            const longParams = "a".repeat(513);

            const res = await request(app)
                .get(`/api/browse/ytmusic/mood-playlists?params=${longParams}`)
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(
                /required and must be a non-empty string/i,
            );
        });

        it("maps ytmusic mood-playlists 4xx without detail to fallback message", async () => {
            ytMusicService.getMoodPlaylists.mockRejectedValueOnce({
                response: { status: 400, data: {} },
            });

            const res = await request(app)
                .get("/api/browse/ytmusic/mood-playlists?params=valid")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(400);
            expect(res.body).toEqual({
                error: "Invalid request for mood playlists",
            });
        });

        it("covers ytmusic mood-playlists disabled, cached, and generic 500 branches", async () => {
            mockGetSystemSettings.mockResolvedValueOnce({
                ytMusicEnabled: false,
            });
            const disabled = await request(app)
                .get("/api/browse/ytmusic/mood-playlists?params=focus")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(disabled.status).toBe(403);

            ytMusicService.getMoodPlaylists.mockResolvedValue([
                { playlistId: "1" },
            ]);
            const first = await request(app)
                .get("/api/browse/ytmusic/mood-playlists?params=focus")
                .set(AUTH_HEADER, AUTH_VALUE);
            const cached = await request(app)
                .get("/api/browse/ytmusic/mood-playlists?params=focus")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(first.status).toBe(200);
            expect(cached.status).toBe(200);
            expect(ytMusicService.getMoodPlaylists).toHaveBeenCalledTimes(1);

            _resetYtBrowseCache();
            ytMusicService.getMoodPlaylists.mockRejectedValueOnce(
                new Error("mood down"),
            );
            const failing = await request(app)
                .get("/api/browse/ytmusic/mood-playlists?params=focus")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(failing.status).toBe(500);
            expect(failing.body).toEqual({
                error: "Failed to fetch mood playlists",
            });
        });

        it("covers ytmusic album disabled, cached, and generic 500 branches", async () => {
            mockGetSystemSettings.mockResolvedValueOnce({
                ytMusicEnabled: false,
            });
            const disabled = await request(app)
                .get("/api/browse/ytmusic/album/ALBUM-1")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(disabled.status).toBe(403);

            ytMusicService.getBrowseAlbum.mockResolvedValue({
                title: "Album",
                artist: "Artist",
                year: "2024",
                trackCount: 1,
                coverUrl: "http://img",
                tracks: [
                    {
                        videoId: "v1",
                        title: "T1",
                        artist: "Artist",
                        artists: ["Artist"],
                        duration_seconds: 100,
                    },
                ],
            });
            const first = await request(app)
                .get("/api/browse/ytmusic/album/ALBUM-1")
                .set(AUTH_HEADER, AUTH_VALUE);
            const cached = await request(app)
                .get("/api/browse/ytmusic/album/ALBUM-1")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(first.status).toBe(200);
            expect(cached.status).toBe(200);
            expect(ytMusicService.getBrowseAlbum).toHaveBeenCalledTimes(1);

            _resetYtBrowseCache();
            ytMusicService.getBrowseAlbum.mockRejectedValueOnce(
                new Error("album down"),
            );
            const failing = await request(app)
                .get("/api/browse/ytmusic/album/ALBUM-2")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(failing.status).toBe(500);
            expect(failing.body).toEqual({ error: "Failed to fetch album" });
        });

        it("covers ytmusic playlist disabled, cached, and generic 500 branches", async () => {
            mockGetSystemSettings.mockResolvedValueOnce({
                ytMusicEnabled: false,
            });
            const disabled = await request(app)
                .get("/api/browse/ytmusic/playlist/PL-1")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(disabled.status).toBe(403);

            ytMusicService.getBrowsePlaylist.mockResolvedValue({
                id: "PL-1",
                title: "P",
                tracks: [],
            });
            const first = await request(app)
                .get("/api/browse/ytmusic/playlist/PL-1")
                .set(AUTH_HEADER, AUTH_VALUE);
            const cached = await request(app)
                .get("/api/browse/ytmusic/playlist/PL-1")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(first.status).toBe(200);
            expect(cached.status).toBe(200);
            expect(ytMusicService.getBrowsePlaylist).toHaveBeenCalledTimes(1);

            _resetYtBrowseCache();
            ytMusicService.getBrowsePlaylist.mockRejectedValueOnce(
                new Error("playlist down"),
            );
            const failing = await request(app)
                .get("/api/browse/ytmusic/playlist/PL-2")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(failing.status).toBe(500);
            expect(failing.body).toEqual({ error: "Failed to fetch playlist" });
        });

        it("maps ytmusic mixes non-401 4xx to a static sanitized message", async () => {
            ytMusicService.getLibraryPlaylists.mockRejectedValueOnce({
                response: { status: 403, data: { detail: "YT OAuth missing" } },
            });

            const res = await request(app)
                .get("/api/browse/ytmusic/mixes")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(403);
            expect(res.body).toEqual({ error: "Invalid request for mixes" });
            expect(JSON.stringify(res.body)).not.toContain("YT OAuth missing");
        });

        it("returns 500 for ytmusic mixes non-http failures", async () => {
            ytMusicService.getLibraryPlaylists.mockRejectedValueOnce(
                new Error("boom"),
            );

            const res = await request(app)
                .get("/api/browse/ytmusic/mixes")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({
                error: "Failed to fetch YT Music mixes",
            });
        });

        it("covers ytmusic mixes disabled and cached branches", async () => {
            mockGetSystemSettings.mockResolvedValueOnce({
                ytMusicEnabled: false,
            });
            const disabled = await request(app)
                .get("/api/browse/ytmusic/mixes")
                .set(AUTH_HEADER, AUTH_VALUE);
            expect(disabled.status).toBe(403);

            ytMusicService.getLibraryPlaylists.mockResolvedValue([
                { playlistId: "mix-1" },
            ]);
            const first = await request(app)
                .get("/api/browse/ytmusic/mixes")
                .set(AUTH_HEADER, AUTH_VALUE);
            const cached = await request(app)
                .get("/api/browse/ytmusic/mixes")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(first.status).toBe(200);
            expect(cached.status).toBe(200);
            expect(ytMusicService.getLibraryPlaylists).toHaveBeenCalledTimes(1);
        });
    });
});
