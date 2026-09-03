import { RecommendationEngine } from "../engine";
import type { RecommendationCandidate } from "../types";

function candidate(
    id: string,
    overrides: Partial<RecommendationCandidate> = {},
): RecommendationCandidate {
    return {
        id: `yt:${id}`,
        canonicalKey: `meta:artist-${id}:${id}:180`,
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
        ...overrides,
    };
}

describe("unified recommendation engine", () => {
    function dependencies(mode: "baseline" | "shadow" | "active" = "active") {
        return {
            mode,
            hybridRolloutPercent: 100,
            explorationRate: 0.1,
            loadCandidates: jest.fn().mockResolvedValue({
                candidates: [candidate("recent"), candidate("fresh")],
                nextCursor: 1,
                degradedSources: ["listenbrainz"],
            }),
            resolveCanonical: jest.fn(
                async (track: RecommendationCandidate) => ({
                    id: `canonical-${track.id}`,
                    canonicalKey: track.canonicalKey,
                }),
            ),
            loadRecentExposures: jest.fn().mockResolvedValue([
                {
                    canonicalKey: "meta:artist-recent:recent:180",
                    exposedAt: new Date("2026-09-01T08:00:00.000Z"),
                },
            ]),
            loadDislikedCanonicalKeys: jest.fn().mockResolvedValue(new Set()),
            loadTasteContext: jest.fn().mockResolvedValue({
                positiveCentroids: [],
                negativeCentroids: [],
            }),
            recordGeneration: jest
                .fn()
                .mockResolvedValueOnce("served-generation")
                .mockResolvedValueOnce("shadow-generation"),
            scheduleHotSet: jest.fn().mockResolvedValue(undefined),
            now: jest.fn(() => new Date("2026-09-01T12:00:00.000Z")),
        };
    }

    const request = {
        userId: "alice",
        intent: {
            surface: "wave" as const,
            direction: "for-you" as const,
            mood: null,
        },
        sessionId: "session-a",
        cursor: 0,
        limit: 10,
        exclude: [],
    };

    it("serves one account-scoped ranked result with persistent anti-repeat", async () => {
        const deps = dependencies();
        const engine = new RecommendationEngine(deps);

        const result = await engine.recommend(request);

        expect(result.tracks.map((track) => track.id)).toEqual(["yt:fresh"]);
        expect(result.generationId).toBe("served-generation");
        expect(result.degradedSources).toEqual(["listenbrainz"]);
        expect(deps.loadRecentExposures).toHaveBeenCalledWith(
            "alice",
            new Date("2026-09-01T12:00:00.000Z"),
        );
        expect(deps.recordGeneration).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "alice",
                served: true,
                algorithm: "hybrid-v2",
            }),
        );
    });

    it("records hybrid shadow ranking while serving the safe baseline", async () => {
        const deps = dependencies("shadow");
        deps.loadRecentExposures.mockResolvedValue([]);
        const engine = new RecommendationEngine(deps);

        const result = await engine.recommend(request);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(result.tracks.map((track) => track.id)).toEqual([
            "yt:recent",
            "yt:fresh",
        ]);
        expect(deps.recordGeneration).toHaveBeenCalledTimes(2);
        expect(deps.recordGeneration).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                algorithm: "hybrid-v2",
                served: false,
            }),
        );
    });

    it("keeps non-canary accounts on baseline while persisting paired hybrid shadow", async () => {
        const deps = dependencies("active");
        deps.hybridRolloutPercent = 0;
        deps.loadRecentExposures.mockResolvedValue([]);
        const engine = new RecommendationEngine(deps);

        const result = await engine.recommend(request);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(result.tracks.map((track) => track.id)).toEqual([
            "yt:recent",
            "yt:fresh",
        ]);
        expect(deps.recordGeneration).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ algorithm: "baseline-v1", served: true }),
        );
        expect(deps.recordGeneration).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ algorithm: "hybrid-v2", served: false }),
        );
    });

    it("keeps playable fallback candidates when an optional adapter degrades", async () => {
        const deps = dependencies();
        deps.loadCandidates.mockResolvedValue({
            candidates: [candidate("fallback")],
            nextCursor: 2,
            degradedSources: ["listenbrainz", "dclap"],
        });
        const engine = new RecommendationEngine(deps);

        const result = await engine.recommend({ ...request, cursor: 1 });

        expect(result.tracks).toHaveLength(1);
        expect(result.degradedSources).toEqual(["listenbrainz", "dclap"]);
        expect(result.nextCursor).toBe(2);
    });

    it("keeps the served result available when telemetry rejects it", async () => {
        const deps = dependencies();
        deps.loadRecentExposures.mockResolvedValue([]);
        const metrics = {
            recordGeneration: jest.fn(() => {
                throw new Error("metrics unavailable");
            }),
        };
        const engine = new RecommendationEngine(deps, metrics);

        await expect(engine.recommend(request)).resolves.toEqual(
            expect.objectContaining({ generationId: "served-generation" }),
        );
        expect(metrics.recordGeneration).toHaveBeenCalledWith(
            expect.objectContaining({
                algorithm: "hybrid-v2",
                served: true,
                degradedSourceCount: 1,
            }),
        );
    });

    it("enriches resolved canonical candidates in one optional feature-store pass", async () => {
        const deps = {
            ...dependencies(),
            enrichCandidates: jest.fn(
                async (tracks: RecommendationCandidate[]) =>
                    tracks.map((track) => ({
                        ...track,
                        embedding: [1, 0],
                        audioFeatures: { energy: 0.8 },
                    })),
            ),
        };
        deps.loadRecentExposures.mockResolvedValue([]);
        const engine = new RecommendationEngine(deps);

        const result = await engine.recommend(request);

        expect(deps.enrichCandidates).toHaveBeenCalledTimes(1);
        expect(result.tracks[0]).toEqual(
            expect.objectContaining({
                embedding: [1, 0],
                audioFeatures: { energy: 0.8 },
            }),
        );
    });
});
