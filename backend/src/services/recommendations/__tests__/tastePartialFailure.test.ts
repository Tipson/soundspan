jest.mock("../../../utils/db", () => ({ prisma: {} }));
jest.mock("../../../utils/logger", () => {
    const logger = { warn: jest.fn(), child: jest.fn() };
    logger.child.mockReturnValue(logger);
    return { logger };
});

import { RecommendationFeatureStore } from "../featureStore";

it("keeps dislikes, listening and session taste when optional saved-like audio anchors fail", async () => {
    const now = new Date("2026-11-12T12:00:00Z");
    const positive = {
        embedding: [1, 0],
        outcome: "completed",
        completionRatio: 1,
        listenedSeconds: 180,
    };
    const negative = {
        embedding: [0, 1],
        outcome: "skipped",
        completionRatio: 0.02,
        listenedSeconds: 4,
    };
    const store = new RecommendationFeatureStore({
        loadCanonicalFeatures: async () => [],
        loadTasteRows: async () => [positive, negative],
        loadLikedEmbeddings: async () => {
            throw new Error("optional audio analysis unavailable");
        },
        loadDislikedEmbeddings: async () => [[0, 1]],
        loadDislikedCanonicalKeys: async () => ["canonical:disliked"],
        loadSeedCanonicalRecordingId: async () => null,
        loadSessionRows: async () => [{ ...negative, playedAt: now }],
        loadContextRows: async () => [positive],
        now: () => now,
    });
    const result = await store.loadTasteContext("listener", {
        sessionId: "session",
        surface: "wave",
        context: { localHour: 15 },
    });
    expect(result.positiveCentroids.some((vector) => vector[0] > 0.9)).toBe(
        true,
    );
    expect(result.negativeCentroids.some((vector) => vector[1] > 0.9)).toBe(
        true,
    );
    expect(result.sessionNegativeEmbedding?.[1]).toBeGreaterThan(0.9);
    expect(result.sessionSignalCount).toBe(1);
    expect(result.contextCentroids.some((vector) => vector[0] > 0.9)).toBe(
        true,
    );
    expect(await store.loadDislikedCanonicalKeys("listener")).toEqual(
        new Set(["canonical:disliked"]),
    );
});
