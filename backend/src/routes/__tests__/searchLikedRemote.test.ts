import type { Request, Response } from "express";
import express from "express";
import request from "supertest";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: Request, _res: Response, next: () => void) => {
        req.user = {
            id: req.get("x-fixture-owner") || "owner-a",
            username: "fixture",
            role: "user",
        };
        next();
    },
}));
jest.mock("../../utils/db", () => ({ prisma: {} }));
jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../utils/redis", () => ({ redisClient: {} }));
jest.mock("../../services/lastfm", () => ({ lastFmService: {} }));
jest.mock("../../services/youtubeMusic", () => ({ ytMusicService: {} }));
jest.mock("../../services/ytMusicDiscoveryCatalog", () => ({}));
jest.mock("../../utils/systemSettings", () => ({}));
jest.mock("../../middleware/rateLimiter", () => ({
    ytMusicSearchLimiter: (_req: Request, _res: Response, next: () => void) =>
        next(),
}));
jest.mock("../../services/search", () => ({
    searchService: { searchAll: jest.fn(), searchByType: jest.fn() },
    normalizeCacheQuery: (query: string) => query.trim().toLowerCase(),
}));
jest.mock("../../services/likedRemoteSearch", () => ({
    searchLikedRemoteTracks: jest.fn(),
}));

import router from "../search";
import { searchService } from "../../services/search";
import { searchLikedRemoteTracks } from "../../services/likedRemoteSearch";

const searchAll = jest.mocked(searchService.searchAll);
const searchByType = jest.mocked(searchService.searchByType);
const searchLiked = jest.mocked(searchLikedRemoteTracks);
const app = express();
app.use("/search", router);

function localResults() {
    return {
        artists: [],
        albums: [],
        tracks: [],
        audiobooks: [],
        podcasts: [],
        episodes: [],
    };
}

function load(query: Record<string, string>, userId = "owner-a") {
    return request(app)
        .get("/search")
        .query(query)
        .set("x-fixture-owner", userId);
}

function personalTrack(userId: string) {
    const id = userId === "owner-a" ? "-1_1" : "-1_2";
    const artist = { id: null, name: "Artist" };
    return {
        id: `vk:${id}`,
        title: "Needle",
        duration: 180,
        trackNo: null,
        filePath: null,
        likedAt: "2026-11-17T12:00:00.000Z",
        source: "vk" as const,
        mediaSource: "vk" as const,
        streamSource: "vk" as const,
        provider: {
            source: "vk" as const,
            providerTrackId: id,
            youtubeVideoId: null,
            tidalTrackId: null,
        },
        artist,
        album: { id: null, title: "", coverArt: null, artist },
        musicSourceRecording: {
            provider: "vk" as const,
            id,
            title: "Needle",
            artists: ["Artist"],
            duration: 180,
            contentVersion: "clean" as const,
            preview: false as const,
        },
    };
}

beforeEach(() => {
    jest.resetAllMocks();
    searchAll.mockResolvedValue(localResults());
    searchByType.mockResolvedValue(localResults());
    searchLiked.mockResolvedValue({
        streamingTracks: [],
        streamingPage: { offset: 0, limit: 20, hasMore: false },
    });
});

it("attaches each owner's personal page without changing a shared cached result", async () => {
    const shared = Object.freeze(localResults());
    searchAll.mockResolvedValue(shared);
    searchLiked.mockImplementation(async ({ userId, offset, limit }) => ({
        streamingTracks: [personalTrack(userId)],
        streamingPage: { offset, limit, hasMore: false },
    }));
    const first = await load({ q: "Needle", offset: "9" });
    const second = await load({ q: "Needle" }, "owner-b");
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({ streamingTracks: [{ id: "vk:-1_1" }] });
    expect(second.body).toMatchObject({ streamingTracks: [{ id: "vk:-1_2" }] });
    expect(shared).toEqual(localResults());
    expect(searchLiked).toHaveBeenNthCalledWith(1, {
        userId: "owner-a",
        query: "Needle",
        offset: 0,
        limit: 20,
    });
    expect(searchLiked).toHaveBeenNthCalledWith(2, {
        userId: "owner-b",
        query: "Needle",
        offset: 0,
        limit: 20,
    });
    expect(first.headers["cache-control"]).toBe("private, no-store");
});

it("keeps the old local track shape when personal storage fails", async () => {
    searchAll.mockResolvedValue({
        ...localResults(),
        tracks: [
            {
                id: "local-1",
                title: "Needle",
                albumId: "album-1",
                albumTitle: "Album",
                artistId: "artist-1",
                artistName: "Artist",
                duration: 180,
                rank: 1,
            },
        ],
    });
    searchLiked.mockRejectedValue(new Error("private DB detail"));
    const res = await load({ q: "Needle" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
        tracks: [
            {
                id: "local-1",
                album: { id: "album-1", artist: { id: "artist-1" } },
            },
        ],
        streamingTracks: [],
        streamingUnavailable: true,
        streamingPage: { offset: 0, limit: 20, hasMore: false },
    });
    expect(JSON.stringify(res.body)).not.toContain("private DB detail");
});

it("uses the validated track offset and bounded limit for the personal raw page", async () => {
    await load({ q: "Needle", type: "tracks", offset: "37", limit: "999" });
    expect(searchLiked).toHaveBeenCalledWith({
        userId: "owner-a",
        query: "Needle",
        offset: 37,
        limit: 100,
    });
    expect(searchByType).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 37, limit: 100 }),
    );
});

const excludedFilters: Record<string, string>[] = [
    { source: "local" },
    { source: "peers" },
    { genre: "rock" },
    { type: "artists" },
    { type: "albums" },
    { type: "audiobooks" },
    { type: "podcasts" },
    { type: "episodes" },
];
it.each(excludedFilters)(
    "does not bypass a source, genre or entity filter %j",
    async (filter) => {
        const res = await load({ q: "Needle", ...filter });
        expect(res.body).toEqual(localResults());
        expect(searchLiked).not.toHaveBeenCalled();
    },
);

it("returns an empty personal page for a blank query without reading storage", async () => {
    const res = await load({
        q: "   ",
        type: "tracks",
        offset: "6",
        limit: "0",
    });
    expect(res.body).toMatchObject({
        streamingTracks: [],
        streamingPage: { offset: 6, limit: 1, hasMore: false },
    });
    expect(searchAll).not.toHaveBeenCalled();
    expect(searchByType).not.toHaveBeenCalled();
    expect(searchLiked).not.toHaveBeenCalled();
});
