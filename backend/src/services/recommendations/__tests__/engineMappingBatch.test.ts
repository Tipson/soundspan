import { RecommendationEngine } from "../engine";
import { providerTrackIdentityToCandidate } from "../canonicalIdentity";
const tracks = ["a", "b"].map((id) =>
    providerTrackIdentityToCandidate({
        source: "youtube",
        providerTrackId: id,
        title: id,
        artist: id,
    }),
);
const request = {
    userId: "alice",
    sessionId: "diagnostic",
    limit: 2,
    intent: { surface: "wave" as const, direction: "for-you" as const },
};

function setup() {
    const dependencies = {
        mode: "baseline" as const,
        hybridRolloutPercent: 0,
        explorationRate: 0,
        now: () => new Date("2026-09-09T00:00:00Z"),
        loadCandidates: async () => ({
            candidates: tracks,
            nextCursor: 1,
            degradedSources: [],
        }),
        loadCanonicalMappings: jest
            .fn()
            .mockResolvedValue([
                { id: "known-a", canonicalKey: "known:a" },
                null,
            ]),
        resolveCanonical: jest.fn(async (c: (typeof tracks)[number]) => ({
            id: c.id,
            canonicalKey: c.id,
        })),
        loadRecentExposures: async () => [],
        loadDislikedCanonicalKeys: async () => new Set<string>(),
        loadTasteContext: async () => ({
            positiveCentroids: [],
            negativeCentroids: [],
        }),
        recordGeneration: async () => "generation",
        scheduleHotSet: async () => {},
    };
    return { dependencies, engine: new RecommendationEngine(dependencies) };
}
it("resolves only missing mappings and preserves candidate order", async () => {
    const { engine, dependencies } = setup();
    const result = await engine.recommend(request);
    expect(result.tracks.map((t) => t.canonicalRecordingId)).toEqual([
        "known-a",
        "youtube:b",
    ]);
    expect(dependencies.loadCanonicalMappings).toHaveBeenCalledWith(tracks);
    expect(dependencies.resolveCanonical.mock.calls).toEqual([[tracks[1]]]);
});
it("retains individual resolution when batch lookup fails", async () => {
    const { engine, dependencies } = setup();
    dependencies.loadCanonicalMappings.mockRejectedValue(
        new Error("transient read failure"),
    );
    const result = await engine.recommend(request);
    expect(result.tracks).toHaveLength(2);
    expect(dependencies.resolveCanonical).toHaveBeenCalledTimes(2);
});
