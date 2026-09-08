import { RecommendationFeatureStore } from "../featureStore";
import type { RecommendationCandidate } from "../types";

function candidate(id: string): RecommendationCandidate {
    return {
        id: `yt:${id}`,
        canonicalKey: `meta:${id}`,
        canonicalRecordingId: `canonical-${id}`,
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

describe("canonical recommendation feature store", () => {
    it("anchors an unplayed saved library in the audio taste profile", async () => {
        const dependencies = {
            loadCanonicalFeatures: jest.fn().mockResolvedValue([]),
            loadTasteRows: jest.fn().mockResolvedValue([]),
            loadLikedEmbeddings: jest.fn().mockResolvedValue([
                [1, 0],
                [0, 1],
            ]),
            loadDislikedCanonicalKeys: jest.fn().mockResolvedValue([]),
            loadSeedCanonicalRecordingId: jest.fn().mockResolvedValue(null),
            loadSessionRows: jest.fn().mockResolvedValue([]),
            loadContextRows: jest.fn().mockResolvedValue([]),
            now: () => new Date("2026-09-01T12:00:00Z"),
        };
        const taste = await new RecommendationFeatureStore(
            dependencies,
        ).loadTasteContext("alice");
        expect(dependencies.loadLikedEmbeddings).toHaveBeenCalledWith("alice");
        expect(taste.positiveCentroids.length).toBeGreaterThan(0);
        expect(taste.negativeCentroids).toEqual([]);
        expect(taste.sessionSignalCount).toBe(0);
    });

    it("does not let hundreds of passive plays erase a saved taste direction", async () => {
        const dependencies = {
            loadCanonicalFeatures: jest.fn().mockResolvedValue([]),
            loadTasteRows: jest.fn().mockResolvedValue(
                Array.from({ length: 500 }, () => ({
                    embedding: [1, 0],
                    outcome: "completed",
                    completionRatio: 1,
                    listenedSeconds: 200,
                })),
            ),
            loadLikedEmbeddings: jest.fn().mockResolvedValue([[0, 1]]),
            loadDislikedCanonicalKeys: jest.fn().mockResolvedValue([]),
            loadSeedCanonicalRecordingId: jest.fn().mockResolvedValue(null),
            loadSessionRows: jest.fn().mockResolvedValue([]),
            loadContextRows: jest.fn().mockResolvedValue([]),
            now: () => new Date("2026-09-01T12:00:00Z"),
        };
        const taste = await new RecommendationFeatureStore(
            dependencies,
        ).loadTasteContext("alice");
        expect(taste.positiveCentroids.some((center) => center[1] > 0.99)).toBe(
            true,
        );
        expect(taste.positiveCentroids.some((center) => center[0] > 0.99)).toBe(
            true,
        );
        expect(taste.positiveCentroids.length).toBeLessThanOrEqual(10);
    });

    it("enriches all candidates through one bounded canonical lookup", async () => {
        const dependencies = {
            loadCanonicalFeatures: jest.fn().mockResolvedValue([
                {
                    canonicalRecordingId: "canonical-one",
                    embedding: [1, 0],
                    bpm: 128,
                    energy: 0.9,
                    arousal: 0.3,
                    valence: 0.7,
                    danceability: 0.8,
                    instrumentalness: 0.1,
                },
            ]),
            loadTasteRows: jest.fn().mockResolvedValue([]),
            loadDislikedCanonicalKeys: jest.fn().mockResolvedValue([]),
            loadSeedCanonicalRecordingId: jest.fn().mockResolvedValue(null),
            loadSessionRows: jest.fn().mockResolvedValue([]),
            loadContextRows: jest.fn().mockResolvedValue([]),
            now: () => new Date("2026-09-01T12:00:00Z"),
        };
        const store = new RecommendationFeatureStore(dependencies);

        const result = await store.enrichCandidates([
            candidate("one"),
            candidate("two"),
        ]);

        expect(dependencies.loadCanonicalFeatures).toHaveBeenCalledWith([
            "canonical-one",
            "canonical-two",
        ]);
        expect(result[0]).toEqual(
            expect.objectContaining({
                embedding: [1, 0],
                audioFeatures: expect.objectContaining({
                    bpm: 128,
                    energy: 0.9,
                    arousal: 0.3,
                }),
            }),
        );
        expect(result[1].embedding).toBeUndefined();
    });

    it("builds account-scoped multi-centroid taste and keeps failures neutral", async () => {
        const dependencies = {
            loadCanonicalFeatures: jest.fn().mockResolvedValue([]),
            loadTasteRows: jest.fn().mockImplementation((userId: string) => {
                expect(userId).toBe("alice");
                return Promise.resolve([
                    {
                        embedding: [1, 0],
                        outcome: "completed",
                        completionRatio: 1,
                        listenedSeconds: 220,
                    },
                    {
                        embedding: [0.9, 0.1],
                        outcome: "meaningful",
                        completionRatio: 0.7,
                        listenedSeconds: 180,
                    },
                    {
                        embedding: [0, 1],
                        outcome: "skipped",
                        completionRatio: 0.05,
                        listenedSeconds: 8,
                    },
                    {
                        embedding: [-1, 0],
                        outcome: "failed",
                        completionRatio: 0,
                        listenedSeconds: 0,
                    },
                ]);
            }),
            loadDislikedCanonicalKeys: jest.fn().mockResolvedValue([]),
            loadSeedCanonicalRecordingId: jest.fn().mockResolvedValue(null),
            loadSessionRows: jest.fn().mockResolvedValue([]),
            loadContextRows: jest.fn().mockResolvedValue([]),
            now: () => new Date("2026-09-01T12:00:00Z"),
        };
        const store = new RecommendationFeatureStore(dependencies);

        const taste = await store.loadTasteContext("alice");

        expect(taste.positiveCentroids.length).toBeGreaterThan(0);
        expect(taste.positiveCentroids.length).toBeLessThanOrEqual(5);
        expect(taste.negativeCentroids).toHaveLength(1);
        expect(taste.negativeCentroids[0][1]).toBeGreaterThan(0.9);
    });

    it("returns only canonical dislikes loaded for the authenticated account", async () => {
        const dependencies = {
            loadCanonicalFeatures: jest.fn().mockResolvedValue([]),
            loadTasteRows: jest.fn().mockResolvedValue([]),
            loadDislikedCanonicalKeys: jest
                .fn()
                .mockResolvedValue(["meta:alice-dislike"]),
            loadSeedCanonicalRecordingId: jest.fn().mockResolvedValue(null),
            loadSessionRows: jest.fn().mockResolvedValue([]),
            loadContextRows: jest.fn().mockResolvedValue([]),
            now: () => new Date("2026-09-01T12:00:00Z"),
        };
        const store = new RecommendationFeatureStore(dependencies);

        const result = await store.loadDislikedCanonicalKeys("alice");

        expect(dependencies.loadDislikedCanonicalKeys).toHaveBeenCalledWith(
            "alice",
        );
        expect(result).toEqual(new Set(["meta:alice-dislike"]));
    });

    it("loads the active canonical embedding for a Similar Tracks seed", async () => {
        const dependencies = {
            loadCanonicalFeatures: jest.fn().mockResolvedValue([
                {
                    canonicalRecordingId: "canonical-seed",
                    embedding: [0.2, 0.8],
                    bpm: 90,
                    energy: 0.3,
                    valence: 0.5,
                    danceability: 0.2,
                    instrumentalness: 0.7,
                },
            ]),
            loadTasteRows: jest.fn().mockResolvedValue([]),
            loadDislikedCanonicalKeys: jest.fn().mockResolvedValue([]),
            loadSeedCanonicalRecordingId: jest
                .fn()
                .mockResolvedValue("canonical-seed"),
            loadSessionRows: jest.fn().mockResolvedValue([]),
            loadContextRows: jest.fn().mockResolvedValue([]),
            now: () => new Date("2026-09-01T12:00:00Z"),
        };
        const store = new RecommendationFeatureStore(dependencies);

        const embedding = await store.loadSeedEmbedding("yt:seed-video");

        expect(dependencies.loadSeedCanonicalRecordingId).toHaveBeenCalledWith(
            "yt:seed-video",
        );
        expect(dependencies.loadCanonicalFeatures).toHaveBeenCalledWith([
            "canonical-seed",
        ]);
        expect(embedding).toEqual([0.2, 0.8]);
    });

    it("builds a decayed fast profile from the last session actions", async () => {
        const now = new Date("2026-09-01T12:00:00Z");
        const dependencies = {
            loadCanonicalFeatures: jest.fn().mockResolvedValue([]),
            loadTasteRows: jest.fn().mockResolvedValue([]),
            loadDislikedCanonicalKeys: jest.fn().mockResolvedValue([]),
            loadSeedCanonicalRecordingId: jest.fn().mockResolvedValue(null),
            loadSessionRows: jest.fn().mockResolvedValue([
                {
                    embedding: [1, 0],
                    outcome: "completed",
                    completionRatio: 1,
                    listenedSeconds: 180,
                    playedAt: new Date("2026-09-01T11:58:00Z"),
                },
                {
                    embedding: [0, 1],
                    outcome: "completed",
                    completionRatio: 1,
                    listenedSeconds: 180,
                    playedAt: new Date("2026-09-01T10:00:00Z"),
                },
                {
                    embedding: [-1, 0],
                    outcome: "skipped",
                    completionRatio: 0.05,
                    listenedSeconds: 4,
                    playedAt: new Date("2026-09-01T11:59:00Z"),
                },
            ]),
            loadContextRows: jest.fn().mockResolvedValue([]),
            now: () => now,
        };
        const store = new RecommendationFeatureStore(dependencies);

        const taste = await store.loadTasteContext("alice", {
            sessionId: "session-a",
        });

        expect(dependencies.loadSessionRows).toHaveBeenCalledWith(
            "alice",
            "session-a",
            30,
        );
        expect(taste.sessionSignalCount).toBe(3);
        expect(taste.sessionPositiveEmbedding?.[0]).toBeGreaterThan(0.9);
        expect(taste.sessionNegativeEmbedding?.[0]).toBeLessThan(-0.9);
    });
});
