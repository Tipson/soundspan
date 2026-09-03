const mockQueryRaw = jest.fn();
const mockDislikedFindMany = jest.fn();
const mockMappingFindMany = jest.fn();
const mockMappingFindFirst = jest.fn();
const mockPlayFindMany = jest.fn();

jest.mock("../../../utils/db", () => ({
    prisma: {
        $queryRaw: mockQueryRaw,
        dislikedEntity: { findMany: mockDislikedFindMany },
        trackMapping: {
            findMany: mockMappingFindMany,
            findFirst: mockMappingFindFirst,
        },
        play: { findMany: mockPlayFindMany },
    },
}));

import { recommendationFeatureStore } from "../featureStore";
import type { RecommendationCandidate } from "../types";

function candidate(
    id: string,
    canonicalRecordingId?: string | null,
): RecommendationCandidate {
    return {
        id: `yt:${id}`,
        canonicalKey: `meta:${id}`,
        canonicalRecordingId,
        title: id,
        duration: 180,
        artist: { id: null, name: `artist-${id}` },
        album: { id: null, title: `album-${id}`, coverArt: null },
        source: "youtube",
        provider: { tidalTrackId: null, youtubeVideoId: id },
        streamSource: "youtube",
        youtubeVideoId: id,
        candidateSources: ["youtube-radio"],
        providerPrior: 1,
    };
}

function rawFeature(canonicalRecordingId: string, embedding: string | null) {
    return {
        canonicalRecordingId,
        embedding,
        bpm: 120,
        energy: 0.8,
        valence: 0.6,
        danceability: 0.7,
        instrumentalness: 0.1,
    };
}

describe("default recommendation feature-store persistence", () => {
    beforeEach(() => {
        mockQueryRaw.mockReset();
        mockDislikedFindMany.mockReset();
        mockMappingFindMany.mockReset();
        mockMappingFindFirst.mockReset();
        mockPlayFindMany.mockReset();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("returns untouched candidates when canonical identities are absent", async () => {
        const input = [candidate("one", null), candidate("two")];

        await expect(
            recommendationFeatureStore.enrichCandidates(input),
        ).resolves.toBe(input);
        expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it("loads active features once and rejects malformed embeddings", async () => {
        mockQueryRaw.mockResolvedValue([
            rawFeature("canonical-one", "[1,0]"),
            rawFeature("canonical-two", "malformed"),
            rawFeature("canonical-three", null),
        ]);
        const withExistingAudio = {
            ...candidate("one", "canonical-one"),
            audioFeatures: { bpm: 90 },
        };

        const result = await recommendationFeatureStore.enrichCandidates([
            withExistingAudio,
            candidate("two", "canonical-two"),
            candidate("three", "canonical-three"),
            candidate("missing", "canonical-missing"),
            candidate("none"),
            candidate("duplicate", "canonical-one"),
        ]);

        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        expect(result[0]).toEqual(
            expect.objectContaining({
                embedding: [1, 0],
                audioFeatures: expect.objectContaining({
                    bpm: 120,
                    energy: 0.8,
                }),
            }),
        );
        expect(result[1].embedding).toBeUndefined();
        expect(result[2].embedding).toBeUndefined();
        expect(result[3]).toEqual(candidate("missing", "canonical-missing"));
        expect(result[4]).toEqual(candidate("none"));
    });

    it("derives positive and negative taste only from valid active vectors", async () => {
        mockQueryRaw.mockResolvedValue([
            {
                embedding: "[1,0]",
                outcome: "completed",
                completionRatio: null,
                listenedSeconds: null,
            },
            {
                embedding: "[0.9,0.1]",
                outcome: null,
                completionRatio: 0.9,
                listenedSeconds: 10,
            },
            {
                embedding: "[0.8,0.2]",
                outcome: "meaningful",
                completionRatio: null,
                listenedSeconds: null,
            },
            {
                embedding: "[0.7,0.3]",
                outcome: null,
                completionRatio: null,
                listenedSeconds: 300,
            },
            {
                embedding: "[0,1]",
                outcome: "skipped",
                completionRatio: null,
                listenedSeconds: null,
            },
            {
                embedding: "[0.1,0.9]",
                outcome: "skipped",
                completionRatio: 0.8,
                listenedSeconds: 5,
            },
            {
                embedding: "[0.2,0.8]",
                outcome: "failed",
                completionRatio: 1,
                listenedSeconds: 500,
            },
            {
                embedding: "[0.4,0.6]",
                outcome: null,
                completionRatio: 0.4,
                listenedSeconds: 60,
            },
            {
                embedding: "invalid",
                outcome: "completed",
                completionRatio: 1,
                listenedSeconds: 500,
            },
        ]);

        const result =
            await recommendationFeatureStore.loadTasteContext("taste-user");

        expect(result.positiveCentroids.length).toBeGreaterThan(0);
        expect(result.negativeCentroids.length).toBeGreaterThan(0);
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });

    it("builds the fast session profile from session-tagged plays", async () => {
        const now = new Date("2026-09-01T12:00:00Z");
        jest.useFakeTimers().setSystemTime(now);
        mockQueryRaw
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([rawFeature("canonical-session", "[1,0]")]);
        mockPlayFindMany.mockResolvedValue([
            {
                trackId: null,
                trackTidalId: null,
                trackYtMusicId: "youtube-row-1",
                playedAt: new Date(now.getTime() - 60_000),
                outcome: "completed",
                completionRatio: 1,
                listenedSeconds: 180,
            },
        ]);
        mockMappingFindMany.mockResolvedValue([
            {
                trackId: null,
                trackTidalId: null,
                trackYtMusicId: "youtube-row-1",
                canonicalRecordingId: "canonical-session",
            },
        ]);

        const result = await recommendationFeatureStore.loadTasteContext(
            "alice",
            { sessionId: "session-a" },
        );

        expect(mockPlayFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    userId: "alice",
                    recommendationSessionId: "session-a",
                },
                take: 30,
            }),
        );
        expect(result.sessionSignalCount).toBe(1);
        expect(result.sessionPositiveEmbedding).toEqual([1, 0]);
    });

    it("returns no canonical dislikes without negative feedback", async () => {
        mockDislikedFindMany.mockResolvedValue([]);

        await expect(
            recommendationFeatureStore.loadDislikedCanonicalKeys("clean-user"),
        ).resolves.toEqual(new Set());
        expect(mockMappingFindMany).not.toHaveBeenCalled();
    });

    it("maps local, YouTube and valid Tidal dislikes to canonical keys", async () => {
        mockDislikedFindMany.mockResolvedValue([
            { entityId: "yt:youtube-video" },
            { entityId: "tidal:123" },
            { entityId: "tidal:not-a-number" },
            { entityId: "tidal:-3" },
            { entityId: "local-track" },
        ]);
        mockMappingFindMany.mockResolvedValue([
            { canonicalRecording: { canonicalKey: "mbid:one" } },
            { canonicalRecording: null },
            { canonicalRecording: { canonicalKey: "" } },
        ]);

        const result =
            await recommendationFeatureStore.loadDislikedCanonicalKeys(
                "dislike-user",
            );

        expect(result).toEqual(new Set(["mbid:one"]));
        expect(mockMappingFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: expect.arrayContaining([
                        { trackId: { in: ["local-track"] } },
                        {
                            trackYtMusic: {
                                is: {
                                    videoId: {
                                        in: ["youtube-video", "local-track"],
                                    },
                                },
                            },
                        },
                        { trackTidal: { is: { tidalId: { in: [123] } } } },
                    ]),
                }),
            }),
        );
    });

    it.each([
        ["yt:only-video", "trackYtMusic"],
        ["tidal:777", "trackTidal"],
    ])(
        "builds a minimal provider-only dislike query for %s",
        async (entityId, relation) => {
            mockDislikedFindMany.mockResolvedValue([{ entityId }]);
            mockMappingFindMany.mockResolvedValue([]);

            await recommendationFeatureStore.loadDislikedCanonicalKeys(
                `only-${relation}`,
            );

            const query = mockMappingFindMany.mock.calls[0][0];
            expect(query.where.OR).toHaveLength(1);
            expect(query.where.OR[0]).toHaveProperty(relation);
        },
    );

    it.each([
        ["yt:video", { trackYtMusic: { is: { videoId: "video" } } }],
        ["related-yt-video", { trackYtMusic: { is: { videoId: "video" } } }],
        ["youtube:video", { trackYtMusic: { is: { videoId: "video" } } }],
        ["tidal:123", { trackTidal: { is: { tidalId: 123 } } }],
        ["local-id", { trackId: "local-id" }],
    ])("loads a seed embedding for %s", async (seedId, expectedIdentity) => {
        mockMappingFindFirst.mockResolvedValue({
            canonicalRecordingId: "canonical-seed",
        });
        mockQueryRaw.mockResolvedValue([
            rawFeature("canonical-seed", "[0.25,0.75]"),
        ]);

        await expect(
            recommendationFeatureStore.loadSeedEmbedding(seedId),
        ).resolves.toEqual([0.25, 0.75]);
        expect(mockMappingFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: expect.arrayContaining([expectedIdentity]),
                }),
            }),
        );
    });

    it.each(["", "yt:", "tidal:invalid", "tidal:-1"])(
        "returns null when %s has no canonical seed mapping",
        async (seedId) => {
            mockMappingFindFirst.mockResolvedValue(null);

            await expect(
                recommendationFeatureStore.loadSeedEmbedding(seedId),
            ).resolves.toBeNull();
            expect(mockQueryRaw).not.toHaveBeenCalled();
        },
    );

    it("returns null when the canonical seed has no active embedding", async () => {
        mockMappingFindFirst.mockResolvedValue({
            canonicalRecordingId: "canonical-seed",
        });
        mockQueryRaw.mockResolvedValue([]);

        await expect(
            recommendationFeatureStore.loadSeedEmbedding("yt:video"),
        ).resolves.toBeNull();
    });
});
