import { RecommendationFeatureStore } from "../featureStore";
import { rankRecommendationCandidates } from "../rankerV2";
import type { RecommendationCandidate } from "../types";
import { RecommendationShadowEvaluationService } from "../shadowEvaluation";

jest.mock("../../../utils/db", () => ({ prisma: {} }));

const now = new Date("2026-09-07T10:00:00Z");

async function taste(
    outcome: string,
    completionRatio: number | null,
    listenedSeconds: number | null,
) {
    const row = {
        embedding: [1, 0],
        outcome,
        completionRatio,
        listenedSeconds,
        playedAt: now,
    };
    return new RecommendationFeatureStore({
        loadCanonicalFeatures: async () => [],
        loadTasteRows: async () => [row],
        loadDislikedCanonicalKeys: async () => [],
        loadSeedCanonicalRecordingId: async () => null,
        loadSessionRows: async () => [row],
        loadContextRows: async () => [row],
        now: () => now,
    }).loadTasteContext("account-a", {
        sessionId: "session-a",
        surface: "wave",
        context: {},
    });
}

describe("skip evidence in Wave taste", () => {
    test("evaluation does not report unmeasured skips as early", async () => {
        const evaluation = new RecommendationShadowEvaluationService({
            loadGenerations: async () => [
                {
                    id: "generation",
                    userId: "account-a",
                    sessionId: "session-a",
                    surface: "wave",
                    direction: "for-you",
                    mood: null,
                    cursor: 0,
                    algorithm: "baseline-v1",
                    served: true,
                    latencyMs: 1,
                    createdAt: now,
                    exposures: [null, 100, 4].map((seconds, index) => ({
                        canonicalKey: String(index),
                        artistKey: String(index),
                        exposedAt: now,
                        viewedAt: now,
                        playedAt: now,
                        listenedSeconds: seconds,
                        completionRatio: null,
                        outcome: "skipped",
                    })),
                },
            ],
        });
        const report = await evaluation.evaluate({
            since: now,
            until: new Date(now.getTime() + 1000),
        });
        expect(report.algorithms.baseline.playability?.earlySkipCount).toBe(1);
    });
    test.each([
        [null, null],
        [0.6, null],
        [null, 100],
    ] as const)(
        "does not invent an early skip from ratio=%s seconds=%s",
        async (ratio, seconds) => {
            const result = await taste("skipped", ratio, seconds);
            expect(result.negativeCentroids).toEqual([]);
            expect(result.sessionNegativeEmbedding).toBeNull();
            expect(result.sessionSignalCount).toBe(0);
        },
    );

    test.each([
        [0.05, null],
        [null, 4],
        [0.05, 4],
    ] as const)(
        "retains a measured early skip with ratio=%s seconds=%s",
        async (ratio, seconds) => {
            const result = await taste("skipped", ratio, seconds);
            expect(result.sessionNegativeEmbedding).toEqual([1, 0]);
            expect(result.negativeCentroids).toEqual([[1, 0]]);
            expect(result.sessionSignalCount).toBe(1);
        },
    );

    test("network failure does not count as taste or penalize similar music", async () => {
        const result = await taste("failed", 0, 0);
        expect(result.sessionSignalCount).toBe(0);
        expect(result.positiveCentroids).toEqual([]);
        expect(result.negativeCentroids).toEqual([]);
    });

    test("measured skip demotes similar sound, missing measurements do not", async () => {
        const candidates = ["a", "b"].map(
            (id, index): RecommendationCandidate => ({
                id,
                canonicalKey: id,
                title: id,
                duration: 180,
                artist: { id: null, name: id },
                album: { id: null, title: id, coverArt: null },
                source: "youtube",
                provider: { youtubeVideoId: id, tidalTrackId: null },
                streamSource: "youtube",
                youtubeVideoId: id,
                candidateSources: ["youtube-radio"],
                providerPrior: 1,
                embedding: index ? [0, 1] : [1, 0],
            }),
        );
        const rank = async (seconds: number | null) =>
            rankRecommendationCandidates(candidates, {
                ...(await taste("skipped", null, seconds)),
                now,
                limit: 2,
                sessionId: "session-a",
                direction: "familiar",
                mood: null,
                dislikedCanonicalKeys: new Set(),
                exposures: [],
            }).map(({ track }) => track.id);
        expect(await rank(null)).toEqual(["a", "b"]);
        expect(await rank(4)).toEqual(["b", "a"]);
    });
});
