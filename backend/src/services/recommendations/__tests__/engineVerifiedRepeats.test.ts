import { RecommendationEngine } from "../engine";
import type { RecommendationCandidate } from "../types";

const NOW = new Date("2026-10-08T12:00:00Z");
const modes = ["baseline", "shadow", "active"] as const;
function candidate(id: string, canonicalKey = id): RecommendationCandidate {
    return {
        id: `yt:${id}`,
        canonicalKey,
        title: id,
        duration: 180,
        artist: { id: null, name: `Artist ${id}` },
        album: { id: null, title: "Album", coverArt: null },
        source: "youtube",
        streamSource: "youtube",
        provider: { youtubeVideoId: id, tidalTrackId: null },
        candidateSources: ["fixture"],
        providerPrior: 1,
        lane: "discovery",
    };
}
function dependencies(mode: (typeof modes)[number]) {
    return {
        mode,
        hybridRolloutPercent: 100,
        explorationRate: 0,
        loadCandidates: jest.fn().mockResolvedValue({
            candidates: [
                candidate("attempt"),
                candidate("listen"),
                candidate("fresh"),
            ],
            nextCursor: 1,
            degradedSources: [],
        }),
        resolveCanonical: async (track: RecommendationCandidate) => ({
            id: `canonical-${track.id}`,
            canonicalKey: track.canonicalKey,
        }),
        loadRecentExposures: jest.fn().mockResolvedValue([]),
        loadDislikedCanonicalKeys: jest.fn().mockResolvedValue(new Set()),
        loadTasteContext: jest.fn().mockResolvedValue({
            positiveCentroids: [],
            negativeCentroids: [],
        }),
        loadVerifiedRepeatExclusions: jest.fn().mockResolvedValue({
            ids: new Set(["attempt", "listen"]),
            hardIds: new Set(["attempt"]),
        }),
        recordGeneration: jest.fn().mockResolvedValue("generation"),
        scheduleHotSet: jest.fn().mockResolvedValue(undefined),
        now: () => NOW,
    };
}
const request = {
    userId: "alice",
    sessionId: "new-tab-without-plays",
    intent: {
        surface: "wave" as const,
        direction: "for-you" as const,
        mood: null,
    },
    limit: 1,
    perLaneLimit: 1,
};

describe("verified direct actual-history admission", () => {
    it.each(modes)(
        "keeps exact hard/soft repeats out before %s quotas, attribution and hotset",
        async (mode) => {
            const deps = dependencies(mode);
            const result = await new RecommendationEngine(deps).recommend(
                request,
            );
            await new Promise((resolve) => setImmediate(resolve));
            expect(result.tracks.map((track) => track.id)).toEqual([
                "yt:fresh",
            ]);
            expect(deps.loadVerifiedRepeatExclusions).toHaveBeenCalledWith(
                "alice",
                NOW,
            );
            for (const [generation] of deps.recordGeneration.mock.calls)
                expect(
                    generation.recommendations.map(
                        ({ track }: { track: RecommendationCandidate }) =>
                            track.id,
                    ),
                ).toEqual(["yt:fresh"]);
            expect(
                deps.scheduleHotSet.mock.calls[0][0].candidates.map(
                    (track: RecommendationCandidate) => track.id,
                ),
            ).toEqual(["yt:fresh"]);
        },
    );

    it.each(modes)(
        "does not relax the last-day attempt in an empty %s Wave",
        async (mode) => {
            const deps = dependencies(mode);
            deps.loadCandidates.mockResolvedValue({
                candidates: [candidate("attempt")],
                nextCursor: 2,
                degradedSources: [],
            });
            const result = await new RecommendationEngine(deps).recommend(
                request,
            );
            expect(result.tracks).toEqual([]);
            expect(
                deps.recordGeneration.mock.calls[0][0].recommendations,
            ).toEqual([]);
            expect(deps.scheduleHotSet).not.toHaveBeenCalled();
        },
    );

    it.each(modes)(
        "preserves the existing empty-pool older-listening fallback in %s",
        async (mode) => {
            const deps = dependencies(mode);
            deps.loadCandidates.mockResolvedValue({
                candidates: [candidate("attempt"), candidate("listen")],
                nextCursor: 2,
                degradedSources: [],
            });
            expect(
                (
                    await new RecommendationEngine(deps).recommend(request)
                ).tracks.map((track) => track.id),
            ).toEqual(["yt:listen"]);
        },
    );

    it.each(modes)(
        "does not refill Discoveries with a soft repeat in %s",
        async (mode) => {
            const deps = dependencies(mode);
            deps.loadCandidates.mockResolvedValue({
                candidates: [candidate("listen")],
                nextCursor: 2,
                degradedSources: [],
            });
            expect(
                (
                    await new RecommendationEngine(deps).recommend({
                        ...request,
                        intent: { ...request.intent, direction: "new" },
                    })
                ).tracks,
            ).toEqual([]);
        },
    );

    it.each(modes)(
        "does not prepare repeated mood discoveries in %s",
        async (mode) => {
            const deps = dependencies(mode);
            deps.loadCandidates.mockResolvedValue({
                candidates: [
                    candidate("attempt"),
                    candidate("listen"),
                    candidate("fresh"),
                ],
                nextCursor: 2,
                degradedSources: [],
            });
            const result = await new RecommendationEngine(deps).recommend({
                ...request,
                intent: { ...request.intent, mood: "calm" },
            });
            expect(result.tracks).toEqual([]);
            expect(
                deps.scheduleHotSet.mock.calls[0][0].candidates.map(
                    (track: RecommendationCandidate) => track.id,
                ),
            ).toEqual(["yt:fresh"]);
        },
    );

    it("applies the history to time-of-day/made-for-you without a matching session", async () => {
        const deps = dependencies("baseline");
        const result = await new RecommendationEngine(deps).recommend({
            ...request,
            timeOfDay: true,
            intent: { ...request.intent, surface: "made-for-you" },
        });
        expect(result.tracks.map((track) => track.id)).toEqual(["yt:fresh"]);
    });

    it("keeps Home's explicit Listen Again shelf unchanged", async () => {
        const deps = dependencies("baseline");
        const result = await new RecommendationEngine(deps).recommend({
            ...request,
            intent: { ...request.intent, surface: "home" },
        });
        expect(result.tracks.map((track) => track.id)).toEqual(["yt:attempt"]);
        expect(deps.loadVerifiedRepeatExclusions).not.toHaveBeenCalled();
    });

    it("marks failed history as degraded and stops speculative mood analysis", async () => {
        const deps = dependencies("baseline");
        deps.loadVerifiedRepeatExclusions.mockRejectedValue(
            new Error("secret-token/upstream-url"),
        );
        const result = await new RecommendationEngine(deps).recommend({
            ...request,
            intent: { ...request.intent, mood: "calm" },
        });
        expect(result.degradedSources).toContain("source-listening-history");
        expect(JSON.stringify(result)).not.toContain("secret-token");
        expect(deps.scheduleHotSet).not.toHaveBeenCalled();
    });

    it("keeps similar-track automatic radio strict without the personal fallback", async () => {
        const deps = dependencies("baseline");
        deps.loadCandidates.mockResolvedValue({
            candidates: [candidate("listen")],
            nextCursor: 2,
            degradedSources: [],
        });
        const result = await new RecommendationEngine(deps).recommend({
            ...request,
            intent: { ...request.intent, surface: "similar-tracks" },
        });
        expect(result.tracks).toEqual([]);
    });
});
