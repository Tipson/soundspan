import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const mockTrackFindUnique = jest.fn();
const mockPlayCreate = jest.fn();
const mockPlayFindMany = jest.fn();
const mockMusicSourceUpsert = jest.fn();
const mockTransaction = jest.fn();
const mockGeneration = jest.fn();
const mockForwardScrobble = jest.fn();
const mockForwardReference = jest.fn();
const mockAttribute = jest.fn();
const mockEnsureRemote = jest.fn();
const mockResolveRemote = jest.fn();

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: Request, res: Response, next: NextFunction) => {
        const owner = req.header("x-test-owner");
        if (!owner) return res.status(401).json({ error: "Not authenticated" });
        req.user = { id: owner, username: owner, role: "user" };
        next();
    },
}));
jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            findUnique: (...args: unknown[]) => mockTrackFindUnique(...args),
        },
        play: {
            create: (...args: unknown[]) => mockPlayCreate(...args),
            findMany: (...args: unknown[]) => mockPlayFindMany(...args),
        },
        trackMusicSource: {
            upsert: (...args: unknown[]) => mockMusicSourceUpsert(...args),
        },
        recommendationGeneration: {
            findFirst: (...args: unknown[]) => mockGeneration(...args),
        },
        $transaction: (...args: unknown[]) => mockTransaction(...args),
    },
}));
jest.mock("../../utils/logger", () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));
jest.mock("../../services/trackMappingService", () => ({
    trackMappingService: {
        ensureRemoteTrack: (...args: unknown[]) => mockEnsureRemote(...args),
    },
}));
jest.mock("../../services/remoteTrackMetadataResolver", () => ({
    resolveRemoteTrackMetadataForRequest: (...args: unknown[]) =>
        mockResolveRemote(...args),
}));
jest.mock("../../services/scrobbleForwarder", () => ({
    forwardScrobbleIsolated: (...args: unknown[]) =>
        mockForwardScrobble(...args),
    forwardTrackReferenceIsolated: (...args: unknown[]) =>
        mockForwardReference(...args),
}));
jest.mock("../../services/recommendations/exposureStore", () => ({
    recommendationExposureStore: {
        attributePlayback: (...args: unknown[]) => mockAttribute(...args),
    },
}));

import router from "../plays";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/plays", router);
const recording = (provider: "vk" | "yandex") => ({
    provider,
    id: provider === "vk" ? "-12_34" : "123",
    title: "Song",
    artists: ["First", "Second"],
    duration: 180.5,
    contentVersion: "explicit",
    preview: false,
    isrc: "USABC1234567",
});

beforeEach(() => {
    jest.resetAllMocks();
    mockMusicSourceUpsert.mockResolvedValue({ id: "direct-identity" });
    mockPlayCreate.mockImplementation(async ({ data }) => ({
        id: "owned-play",
        ...data,
    }));
    mockPlayFindMany.mockResolvedValue([]);
    mockGeneration.mockResolvedValue(null);
    mockAttribute.mockResolvedValue(undefined);
    mockTransaction.mockImplementation(async (callback) =>
        callback({
            trackMusicSource: { upsert: mockMusicSourceUpsert },
            play: { create: mockPlayCreate },
        }),
    );
});

for (const provider of ["vk", "yandex"] as const) {
    test(`${provider} stores only namespace identity and an owner-scoped public recording snapshot`, async () => {
        const candidate = recording(provider);
        const res = await request(app)
            .post("/api/plays")
            .set("x-test-owner", "owner-a")
            .send({
                musicSourceRecording: {
                    ...candidate,
                    token: "secret",
                    streamUrl: "https://private.invalid/signed",
                    artistsExtra: ["injected"],
                },
                playContext: "wave",
                waveMode: "new",
                recommendationGenerationId: "foreign-generation",
                recommendationSessionId: "session-a",
            });
        expect(res.status).toBe(200);
        expect(mockMusicSourceUpsert).toHaveBeenCalledWith({
            where: {
                provider_providerTrackId: {
                    provider,
                    providerTrackId: candidate.id,
                },
            },
            update: { providerTrackId: candidate.id },
            create: { provider, providerTrackId: candidate.id },
        });
        expect(mockPlayCreate).toHaveBeenCalledWith({
            data: {
                userId: "owner-a",
                trackMusicSourceId: "direct-identity",
                musicSourceRecording: candidate,
                source: provider === "vk" ? "VK" : "YANDEX",
                playedAt: expect.any(Date),
                playContext: "wave",
                waveMode: "new",
                recommendationSessionId: "session-a",
            },
        });
        expect(mockGeneration).toHaveBeenCalledWith({
            where: {
                id: "foreign-generation",
                userId: "owner-a",
                served: true,
            },
            select: { id: true },
        });
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        expect(mockTrackFindUnique).not.toHaveBeenCalled();
        expect(mockResolveRemote).not.toHaveBeenCalled();
        expect(mockEnsureRemote).not.toHaveBeenCalled();
        expect(mockForwardScrobble).not.toHaveBeenCalled();
        expect(mockForwardReference).not.toHaveBeenCalled();
        expect(mockAttribute).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "owner-a",
                provider,
                providerTrackId: candidate.id,
            }),
        );
        expect(JSON.stringify(res.body)).not.toContain("secret");
        expect(JSON.stringify(res.body)).not.toContain("private.invalid");
    });
    test(`${provider} diagnostic playback validates without creating private history or namespace rows`, async () => {
        const res = await request(app)
            .post("/api/plays")
            .set("x-test-owner", "owner-a")
            .set("X-Soundspan-Diagnostic", "playback")
            .send({ musicSourceRecording: recording(provider) });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            id: "diagnostic-playback",
            diagnostic: true,
        });
        expect(mockTransaction).not.toHaveBeenCalled();
        expect(mockMusicSourceUpsert).not.toHaveBeenCalled();
        expect(mockAttribute).not.toHaveBeenCalled();
    });
    test(`${provider} own history retains exact direct metadata and tolerates a removed namespace row`, async () => {
        const candidate = recording(provider);
        const entry = {
            id: "owned-play",
            playedAt: new Date("2026-10-08T00:00:00Z"),
            source: provider === "vk" ? "VK" : "YANDEX",
            musicSourceRecording: candidate,
            trackMusicSource: { provider, providerTrackId: candidate.id },
        };
        mockPlayFindMany.mockResolvedValue([
            entry,
            { ...entry, id: "orphan-play", trackMusicSource: null },
        ]);
        const res = await request(app)
            .get("/api/plays")
            .set("x-test-owner", "owner-a");
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
        const track = res.body[0].track;
        expect(track).toMatchObject({
            id: `${provider}:${candidate.id}`,
            source: provider,
            mediaSource: provider,
            streamSource: provider,
            title: "Song",
            duration: 180.5,
            artist: { name: "First, Second" },
            provider: { source: provider, providerTrackId: candidate.id },
            musicSourceRecording: candidate,
        });
        expect(res.body[1].track).toEqual(track);
        expect(mockPlayFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: "owner-a" },
                include: expect.objectContaining({ trackMusicSource: true }),
            }),
        );
    });
}

test("direct history rejects malformed, conflicting and wrong-source snapshots", async () => {
    const entry = {
        id: "owned-play",
        playedAt: new Date(),
        source: "VK",
        musicSourceRecording: recording("vk"),
        trackMusicSource: { provider: "vk", providerTrackId: "-12_34" },
    };
    mockPlayFindMany.mockResolvedValue([
        {
            ...entry,
            musicSourceRecording: {
                ...entry.musicSourceRecording,
                preview: true,
            },
        },
        { ...entry, source: "YOUTUBE_MUSIC" },
        {
            ...entry,
            trackMusicSource: { provider: "vk", providerTrackId: "999_999" },
        },
        { ...entry, musicSourceRecording: null },
    ]);
    const res = await request(app)
        .get("/api/plays")
        .set("x-test-owner", "owner-a");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
});

test.each([
    { musicSourceRecording: { ...recording("vk"), id: "123" } },
    { musicSourceRecording: { ...recording("yandex"), id: "-12_34" } },
    { musicSourceRecording: { ...recording("vk"), preview: true } },
    { musicSourceRecording: { ...recording("vk"), duration: 0 } },
    { musicSourceRecording: { ...recording("vk"), artists: [] } },
    { musicSourceRecording: { ...recording("vk"), title: " " } },
    { musicSourceRecording: recording("vk"), trackId: "local-track" },
    { musicSourceRecording: recording("vk"), trackId: "" },
    {
        musicSourceRecording: recording("vk"),
        youtubeVideoId: "synthetic01",
        title: "Song",
        artist: "Artist",
        album: "Album",
        duration: 180,
    },
])(
    "invalid or ambiguous direct reference is rejected before writes: %j",
    async (payload) => {
        const res = await request(app)
            .post("/api/plays")
            .set("x-test-owner", "owner-a")
            .send(payload);
        expect(res.status).toBe(400);
        expect(mockTransaction).not.toHaveBeenCalled();
        expect(mockPlayCreate).not.toHaveBeenCalled();
        expect(mockMusicSourceUpsert).not.toHaveBeenCalled();
    },
);

test("direct reference requires authentication before metadata or namespace work", async () => {
    const res = await request(app)
        .post("/api/plays")
        .send({ musicSourceRecording: recording("vk") });
    expect(res.status).toBe(401);
    expect(mockTransaction).not.toHaveBeenCalled();
});
