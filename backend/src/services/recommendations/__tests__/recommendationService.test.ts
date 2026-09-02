import { UnifiedRecommendationService } from "../recommendationService";
import type { RecordEngineGenerationInput } from "../engine";

describe("unified recommendation compatibility facade", () => {
    it("serves legacy Home shelves through the same exposure-aware engine", async () => {
        const recordGeneration = jest.fn().mockResolvedValue("generation-1");
        const scheduleHotSet = jest.fn().mockResolvedValue(undefined);
        const service = new UnifiedRecommendationService({
            mode: "baseline",
            hybridRolloutPercent: 0,
            explorationRate: 0,
            loadPersonalizedFeed: jest.fn().mockResolvedValue({
                shelves: {
                    listenAgain: [track("again")],
                    quickPicks: [track("quick")],
                    discovery: [track("new")],
                },
                degraded: false,
                reason: null,
                seedCount: 1,
                nextCursor: 4,
            }),
            resolveCanonical: jest.fn(async (candidate) => ({
                id: `canonical-${candidate.youtubeVideoId}`,
                canonicalKey: candidate.canonicalKey,
            })),
            enrichCandidates: jest.fn(async (candidates) => candidates),
            loadRecentExposures: jest.fn().mockResolvedValue([]),
            loadDislikedCanonicalKeys: jest.fn().mockResolvedValue(new Set()),
            loadTasteContext: jest.fn().mockResolvedValue({
                positiveCentroids: [],
                negativeCentroids: [],
            }),
            recordGeneration,
            scheduleHotSet,
            loadSimilarCandidates: jest.fn(),
            now: () => new Date("2026-09-01T12:00:00Z"),
        });

        const feed = await service.getPersonalizedFeed({
            userId: "alice",
            sessionId: "session-a",
            surface: "home",
            limit: 12,
            cursor: 3,
            direction: "for-you",
            mood: null,
            excludeVideoIds: [],
        });

        expect(feed.shelves.listenAgain.map(({ id }) => id)).toEqual([
            "yt:again",
        ]);
        expect(feed.shelves.quickPicks.map(({ id }) => id)).toEqual([
            "yt:quick",
        ]);
        expect(feed.shelves.discovery.map(({ id }) => id)).toEqual(["yt:new"]);
        expect(feed.generationId).toBe("generation-1");
        expect(recordGeneration).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "alice",
                surface: "home",
                served: true,
            }),
        );
        expect(scheduleHotSet).toHaveBeenCalledTimes(1);
    });

    it("keeps Home and Wave populated from a reserved pool for one user", async () => {
        const now = new Date("2026-09-01T12:00:00Z");
        const exposures: Array<{ canonicalKey: string; exposedAt: Date }> = [];
        const loadPersonalizedFeed = jest.fn(
            async (_userId: string, sourceLimit: number) => ({
                shelves: {
                    listenAgain: Array.from(
                        { length: sourceLimit },
                        (_, index) => track(`again-${index}`),
                    ),
                    quickPicks: Array.from(
                        { length: sourceLimit },
                        (_, index) => track(`quick-${index}`),
                    ),
                    discovery: Array.from({ length: sourceLimit }, (_, index) =>
                        track(`new-${index}`),
                    ),
                },
                degraded: false,
                reason: null,
                seedCount: sourceLimit * 3,
                nextCursor: 1,
            }),
        );
        const recordGeneration = jest.fn(
            async (input: RecordEngineGenerationInput) => {
                if (input.served) {
                    exposures.push(
                        ...input.recommendations.map(({ track: item }) => ({
                            canonicalKey: item.canonicalKey,
                            exposedAt: now,
                        })),
                    );
                }
                return `generation-${exposures.length}`;
            },
        );
        const service = new UnifiedRecommendationService({
            mode: "active",
            hybridRolloutPercent: 100,
            explorationRate: 0,
            loadPersonalizedFeed,
            resolveCanonical: jest.fn(async (candidate) => ({
                id: `canonical-${candidate.youtubeVideoId}`,
                canonicalKey: candidate.canonicalKey,
            })),
            enrichCandidates: jest.fn(async (candidates) => candidates),
            loadRecentExposures: jest.fn(async () => [...exposures]),
            loadDislikedCanonicalKeys: jest.fn().mockResolvedValue(new Set()),
            loadTasteContext: jest.fn().mockResolvedValue({
                positiveCentroids: [],
                negativeCentroids: [],
            }),
            recordGeneration,
            scheduleHotSet: jest.fn().mockResolvedValue(undefined),
            loadSimilarCandidates: jest.fn(),
            now: () => now,
        });
        const request = {
            userId: "alice",
            sessionId: "same-session",
            limit: 12,
            cursor: 0,
            direction: "for-you" as const,
            mood: null,
            excludeVideoIds: [] as string[],
        };

        const home = await service.getPersonalizedFeed({
            ...request,
            surface: "home",
        });
        const wave = await service.getPersonalizedFeed({
            ...request,
            surface: "wave",
        });
        const homeIds = Object.values(home.shelves).flatMap((items) =>
            items.map(({ id }) => id),
        );
        const waveIds = Object.values(wave.shelves).flatMap((items) =>
            items.map(({ id }) => id),
        );

        for (const shelf of Object.values(home.shelves)) {
            expect(shelf).toHaveLength(12);
        }
        for (const shelf of Object.values(wave.shelves)) {
            expect(shelf).toHaveLength(12);
        }
        expect(waveIds).toHaveLength(36);
        expect(waveIds.filter((id) => homeIds.includes(id))).toEqual([]);
        expect(loadPersonalizedFeed).toHaveBeenNthCalledWith(
            1,
            "alice",
            25,
            expect.any(Object),
        );
        expect(exposures).toHaveLength(72);
    });

    it("backfills Wave shelves when only one reserved candidate remains fresh", async () => {
        const now = new Date("2026-09-01T12:00:00Z");
        const exposures: Array<{ canonicalKey: string; exposedAt: Date }> = [];
        const recordGeneration = jest.fn(
            async (input: RecordEngineGenerationInput) => {
                if (input.served) {
                    exposures.push(
                        ...input.recommendations.map(({ track: item }) => ({
                            canonicalKey: item.canonicalKey,
                            exposedAt: now,
                        })),
                    );
                }
                return `generation-${exposures.length}`;
            },
        );
        const service = new UnifiedRecommendationService({
            mode: "active",
            hybridRolloutPercent: 100,
            explorationRate: 0,
            loadPersonalizedFeed: jest.fn(async () => ({
                shelves: {
                    listenAgain: Array.from({ length: 13 }, (_, index) =>
                        track(`again-${index}`),
                    ),
                    quickPicks: Array.from({ length: 12 }, (_, index) =>
                        track(`quick-${index}`),
                    ),
                    discovery: Array.from({ length: 12 }, (_, index) =>
                        track(`new-${index}`),
                    ),
                },
                degraded: false,
                reason: null,
                seedCount: 37,
                nextCursor: 1,
            })),
            resolveCanonical: jest.fn(async (candidate) => ({
                id: `canonical-${candidate.youtubeVideoId}`,
                canonicalKey: candidate.canonicalKey,
            })),
            enrichCandidates: jest.fn(async (candidates) => candidates),
            loadRecentExposures: jest.fn(async () => [...exposures]),
            loadDislikedCanonicalKeys: jest.fn().mockResolvedValue(new Set()),
            loadTasteContext: jest.fn().mockResolvedValue({
                positiveCentroids: [],
                negativeCentroids: [],
            }),
            recordGeneration,
            scheduleHotSet: jest.fn().mockResolvedValue(undefined),
            loadSimilarCandidates: jest.fn(),
            now: () => now,
        });
        const request = {
            userId: "alice",
            sessionId: "sparse-reserve-session",
            limit: 12,
            cursor: 0,
            direction: "for-you" as const,
            mood: null,
            excludeVideoIds: [] as string[],
        };

        const home = await service.getPersonalizedFeed({
            ...request,
            surface: "home",
        });
        const wave = await service.getPersonalizedFeed({
            ...request,
            surface: "wave",
        });
        const homeIds = new Set(
            Object.values(home.shelves).flatMap((items) =>
                items.map(({ id }) => id),
            ),
        );
        const waveIds = Object.values(wave.shelves).flatMap((items) =>
            items.map(({ id }) => id),
        );

        for (const shelf of Object.values(wave.shelves)) {
            expect(shelf).toHaveLength(12);
        }
        expect(waveIds.filter((id) => !homeIds.has(id))).toHaveLength(1);
        expect(waveIds.filter((id) => homeIds.has(id))).toHaveLength(35);
        expect(exposures).toHaveLength(72);
    });
});

function track(videoId: string) {
    return {
        id: `yt:${videoId}`,
        title: videoId,
        duration: 180,
        trackNo: null,
        artist: { id: null, name: `artist-${videoId}` },
        album: {
            id: null,
            title: `album-${videoId}`,
            coverArt: `https://img/${videoId}.jpg`,
            artist: { id: null, name: `artist-${videoId}` },
        },
        source: "youtube" as const,
        streamSource: "youtube" as const,
        youtubeVideoId: videoId,
        provider: { tidalTrackId: null, youtubeVideoId: videoId },
    };
}
