const mockGetHomeFeed = jest.fn();
const mockFindMatchForTrack = jest.fn();
const mockGetRadio = jest.fn();
const mockResolveCanonical = jest.fn();
const mockEnrichCandidates = jest.fn();
const mockLoadRecent = jest.fn();
const mockLoadDislikedCanonicalKeys = jest.fn();
const mockLoadTasteContext = jest.fn();
const mockLoadSeedEmbedding = jest.fn();
const mockLoadMood = jest.fn();
const mockRecordGeneration = jest.fn();
const mockScheduleHotSet = jest.fn();
const mockWarn = jest.fn();
let capturedDependencies: Record<string, any>;

jest.mock("../../../config", () => ({
    config: { recommendations: { mode: "hybrid" } },
}));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ warn: mockWarn }) },
}));
jest.mock("../../personalizedCatalog", () => ({
    personalizedCatalogService: { getHomeFeed: mockGetHomeFeed },
}));
jest.mock("../../youtubeMusic", () => ({
    ytMusicService: {
        findMatchForTrack: mockFindMatchForTrack,
        getRadio: mockGetRadio,
    },
}));
jest.mock("../canonicalIdentity", () => ({
    buildCanonicalRecordingKey: jest.fn(
        (candidate: { title: string }) => `canonical:${candidate.title}`,
    ),
    canonicalIdentityResolver: { resolve: mockResolveCanonical },
}));
jest.mock("../exposureStore", () => ({
    recommendationExposureStore: {
        loadRecent: mockLoadRecent,
        record: mockRecordGeneration,
    },
}));
jest.mock("../featureStore", () => ({
    recommendationFeatureStore: {
        enrichCandidates: mockEnrichCandidates,
        loadDislikedCanonicalKeys: mockLoadDislikedCanonicalKeys,
        loadTasteContext: mockLoadTasteContext,
        loadSeedEmbedding: mockLoadSeedEmbedding,
    },
}));
jest.mock("../moodEmbedding", () => ({
    recommendationMoodEmbeddingStore: { load: mockLoadMood },
}));
jest.mock("../remoteAnalysisHotSet", () => ({
    remoteAnalysisHotSetScheduler: { schedule: mockScheduleHotSet },
}));
jest.mock("../recommendationService", () => ({
    UnifiedRecommendationService: class {
        constructor(dependencies: Record<string, any>) {
            capturedDependencies = dependencies;
        }
    },
}));

import { unifiedRecommendationService } from "../recommendationRuntime";
import type { RecommendRequest } from "../types";

function request(overrides: Partial<RecommendRequest> = {}): RecommendRequest {
    return {
        userId: "user-1",
        sessionId: "session-1",
        limit: 4,
        cursor: 0,
        intent: { surface: "similar-tracks", direction: "for-you" },
        seed: { id: "yt:seed" },
        ...overrides,
    };
}

describe("recommendation runtime adapters", () => {
    beforeEach(() => {
        mockGetHomeFeed.mockResolvedValue({ shelves: {} });
        mockFindMatchForTrack.mockReset();
        mockGetRadio.mockReset();
        mockResolveCanonical.mockReset();
        mockEnrichCandidates.mockReset();
        mockLoadRecent.mockReset();
        mockLoadDislikedCanonicalKeys.mockReset();
        mockLoadTasteContext.mockReset();
        mockLoadSeedEmbedding.mockReset();
        mockLoadMood.mockReset();
        mockRecordGeneration.mockReset();
        mockScheduleHotSet.mockReset();
        mockWarn.mockReset();
    });

    it("connects the runtime service to its backing stores", async () => {
        expect(unifiedRecommendationService).toBeDefined();
        await capturedDependencies.loadPersonalizedFeed("user-1", 8, {
            cursor: 2,
        });
        expect(mockGetHomeFeed).toHaveBeenCalledWith("user-1", 8, {
            cursor: 2,
        });

        const candidate = { id: "candidate" };
        await capturedDependencies.resolveCanonical(candidate);
        await capturedDependencies.enrichCandidates([candidate]);
        const now = new Date("2026-09-01T12:00:00Z");
        await capturedDependencies.loadRecentExposures("user-1", now);
        await capturedDependencies.loadDislikedCanonicalKeys("user-1");
        await capturedDependencies.recordGeneration({ id: "generation" });
        await capturedDependencies.scheduleHotSet({ id: "candidate" });

        expect(mockResolveCanonical).toHaveBeenCalledWith(candidate);
        expect(mockEnrichCandidates).toHaveBeenCalledWith([candidate]);
        expect(mockLoadRecent).toHaveBeenCalledWith("user-1", now);
        expect(mockLoadDislikedCanonicalKeys).toHaveBeenCalledWith("user-1");
        expect(mockRecordGeneration).toHaveBeenCalledWith({ id: "generation" });
        expect(mockScheduleHotSet).toHaveBeenCalledWith({ id: "candidate" });
        expect(capturedDependencies.now()).toBeInstanceOf(Date);
    });

    it.each(["yt:seed", "related-yt-seed", "youtube:seed"])(
        "loads, normalizes and rotates YouTube radio for %s",
        async (seedId) => {
            mockGetRadio.mockResolvedValue({
                tracks: [
                    {
                        videoId: "seed",
                        title: "Seed",
                        artist: "Artist",
                        artists: ["Artist"],
                        album: "Album",
                        duration: 180,
                        thumbnailUrl: null,
                    },
                    {
                        videoId: "next-1",
                        title: "Next One",
                        artist: "Artist",
                        artists: ["Artist"],
                        artistId: "artist-1",
                        album: "Album",
                        albumId: "album-1",
                        duration: 180.6,
                        thumbnailUrl: "https://example.test/cover.jpg",
                    },
                    {
                        videoId: "next-2",
                        title: "Next Two",
                        artist: "Artist",
                        artists: ["Artist"],
                        album: "",
                        duration: -5,
                        thumbnailUrl: null,
                    },
                    {
                        videoId: "next-1",
                        title: "Duplicate",
                        artist: "Artist",
                        artists: ["Artist"],
                        album: "Album",
                        duration: 180,
                        thumbnailUrl: null,
                    },
                    {
                        videoId: "",
                        title: "Invalid",
                        artist: "Artist",
                        artists: ["Artist"],
                        album: "Album",
                        duration: 180,
                        thumbnailUrl: null,
                    },
                ],
            });

            const result = await capturedDependencies.loadSimilarCandidates(
                request({ seed: { id: seedId }, cursor: 1 }),
            );

            expect(mockGetRadio).toHaveBeenCalledWith("seed", 13);
            expect(result).toEqual({
                candidates: [
                    expect.objectContaining({
                        id: "yt:next-2",
                        canonicalKey: "canonical:Next Two",
                        duration: 0,
                        artist: { id: null, name: "Artist" },
                        album: expect.objectContaining({
                            id: null,
                            title: "Single",
                            coverArt:
                                "https://i.ytimg.com/vi/next-2/hqdefault.jpg",
                        }),
                    }),
                    expect.objectContaining({
                        id: "yt:next-1",
                        duration: 181,
                        artist: { id: "artist-1", name: "Artist" },
                        album: expect.objectContaining({
                            id: "album-1",
                            title: "Album",
                            coverArt: "https://example.test/cover.jpg",
                        }),
                    }),
                ],
                nextCursor: 2,
                degradedSources: [],
            });
        },
    );

    it("resolves a metadata-only seed and wraps a very large cursor", async () => {
        mockFindMatchForTrack.mockResolvedValue({ videoId: "matched" });
        mockGetRadio.mockResolvedValue({
            tracks: [
                {
                    videoId: "next",
                    title: "Next",
                    artist: "Artist",
                    artists: ["Artist"],
                    album: "Album",
                    duration: 180,
                    thumbnailUrl: null,
                },
            ],
        });

        const result = await capturedDependencies.loadSimilarCandidates(
            request({
                limit: 30,
                cursor: 1_000_000,
                seed: { artist: "Artist", title: "Seed" },
            }),
        );

        expect(mockFindMatchForTrack).toHaveBeenCalledWith(
            "user-1",
            "Artist",
            "Seed",
        );
        expect(mockGetRadio).toHaveBeenCalledWith("matched", 51);
        expect(result.nextCursor).toBe(0);
    });

    it.each([
        [{ id: "unknown:seed" }, 7],
        [{ artist: "Artist", title: "Seed" }, 0],
        [undefined, 0],
    ])(
        "degrades cleanly when no playable seed exists",
        async (seed, cursor) => {
            mockFindMatchForTrack.mockResolvedValue(null);

            await expect(
                capturedDependencies.loadSimilarCandidates(
                    request({ seed, cursor }),
                ),
            ).resolves.toEqual({
                candidates: [],
                nextCursor: cursor,
                degradedSources: ["youtube-seed"],
            });
        },
    );

    it("isolates a failed YouTube radio provider", async () => {
        mockGetRadio.mockRejectedValue(new Error("provider down"));

        await expect(
            capturedDependencies.loadSimilarCandidates(
                request({ cursor: undefined }),
            ),
        ).resolves.toEqual({
            candidates: [],
            nextCursor: 0,
            degradedSources: ["youtube"],
        });
        expect(mockWarn).toHaveBeenCalledWith(
            "Similar-track provider adapter degraded",
            expect.objectContaining({ userId: "user-1", seed: "yt:seed" }),
        );
    });

    it("rejects an empty prefixed seed and handles an empty radio queue", async () => {
        await expect(
            capturedDependencies.loadSimilarCandidates(
                request({ seed: { id: "yt:" }, cursor: undefined }),
            ),
        ).resolves.toEqual({
            candidates: [],
            nextCursor: 0,
            degradedSources: ["youtube-seed"],
        });

        mockGetRadio.mockResolvedValue({ tracks: [] });
        await expect(
            capturedDependencies.loadSimilarCandidates(
                request({ seed: { id: "yt:seed" }, cursor: undefined }),
            ),
        ).resolves.toEqual({
            candidates: [],
            nextCursor: 1,
            degradedSources: [],
        });
    });

    it("builds taste context with mood degradation and a Similar Tracks seed", async () => {
        mockLoadTasteContext.mockResolvedValue({
            positiveCentroids: [
                [0, 1],
                [1, 0],
                [0.5, 0.5],
                [0.2, 0.8],
                [0.8, 0.2],
            ],
            negativeCentroids: [],
        });
        mockLoadMood.mockResolvedValue({
            embedding: [0.4, 0.6],
            degraded: true,
        });
        mockLoadSeedEmbedding.mockResolvedValue([1, 1]);

        const result = await capturedDependencies.loadTasteContext(
            "user-1",
            request({
                intent: {
                    surface: "similar-tracks",
                    direction: "for-you",
                    mood: "focus",
                },
            }),
        );

        expect(mockLoadMood).toHaveBeenCalledWith("focus");
        expect(mockLoadSeedEmbedding).toHaveBeenCalledWith("yt:seed");
        expect(result).toEqual(
            expect.objectContaining({
                positiveCentroids: [
                    [1, 1],
                    [0, 1],
                    [1, 0],
                    [0.5, 0.5],
                    [0.2, 0.8],
                ],
                moodEmbedding: [0.4, 0.6],
                degradedSources: ["dclap-mood"],
            }),
        );
    });

    it.each([
        ["home", undefined],
        ["similar-tracks", undefined],
        ["similar-tracks", "yt:seed"],
    ])(
        "keeps neutral taste for %s without an available seed embedding",
        async (surface, seedId) => {
            mockLoadTasteContext.mockResolvedValue({
                positiveCentroids: [[0, 1]],
                negativeCentroids: [],
            });
            mockLoadMood.mockResolvedValue({
                embedding: null,
                degraded: false,
            });
            mockLoadSeedEmbedding.mockResolvedValue(null);

            const result = await capturedDependencies.loadTasteContext(
                "user-1",
                request({
                    intent: {
                        surface:
                            surface as RecommendRequest["intent"]["surface"],
                        direction: "for-you",
                    },
                    seed: seedId ? { id: seedId } : undefined,
                }),
            );

            expect(result).toEqual(
                expect.objectContaining({
                    positiveCentroids: [[0, 1]],
                    moodEmbedding: null,
                    degradedSources: [],
                }),
            );
        },
    );
});
