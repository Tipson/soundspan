import { UnifiedRecommendationService } from "../recommendationService";
import type { RecommendationCandidate } from "../types";

const saved: RecommendationCandidate = {
    id: "yt:calm",
    canonicalRecordingId: "saved-calm",
    canonicalKey: "saved:calm",
    title: "Personal calm song",
    duration: 180,
    artist: { id: null, name: "Personal artist" },
    album: { id: null, title: "Personal album", coverArt: null },
    source: "youtube",
    streamSource: "youtube",
    provider: { tidalTrackId: null, youtubeVideoId: "calm" },
    youtubeVideoId: "calm",
    candidateSources: ["saved-mood"],
    providerPrior: 1.15,
    accountAffinity: 0.55,
    lane: "quickPicks",
    audioFeatures: {
        arousal: 0.15,
        energy: 0.9,
        danceability: 0.1,
        instrumentalness: 0.2,
    },
};
function setup() {
    const loadSavedMoodCandidates = jest.fn().mockResolvedValue([saved]);
    const loadDislikedCanonicalKeys = jest.fn().mockResolvedValue(new Set());
    const deps = {
        mode: "active" as const,
        hybridRolloutPercent: 100,
        explorationRate: 0,
        loadSavedMoodCandidates,
        loadPersonalizedFeed: async () => ({
            shelves: { listenAgain: [], quickPicks: [], discovery: [] },
            degraded: false,
            reason: null,
            seedCount: 1,
            nextCursor: 1,
        }),
        resolveCanonical: async (c: RecommendationCandidate) => ({
            id: c.canonicalRecordingId!,
            canonicalKey: c.canonicalKey,
        }),
        loadRecentExposures: async () => [],
        loadDislikedCanonicalKeys,
        loadTasteContext: async () => ({
            positiveCentroids: [],
            negativeCentroids: [],
        }),
        recordGeneration: async () => "g",
        scheduleHotSet: async () => {},
        loadSimilarCandidates: jest.fn(),
        now: () => new Date(),
    };
    return {
        service: new UnifiedRecommendationService(deps),
        loadSavedMoodCandidates,
        loadDislikedCanonicalKeys,
    };
}
const request = {
    userId: "alice",
    sessionId: "s",
    surface: "wave" as const,
    limit: 12,
    cursor: 0,
    direction: "for-you" as const,
    mood: "calm" as const,
    excludeVideoIds: [],
};
test("mood can reach saved songs outside the pre-truncated provider shelves", async () => {
    const { service, loadSavedMoodCandidates } = setup();
    const feed = await service.getPersonalizedFeed(request);
    expect(loadSavedMoodCandidates).toHaveBeenCalledWith("alice", "calm");
    expect(feed.shelves.quickPicks.map((x) => x.youtubeVideoId)).toEqual([
        "calm",
    ]);
    expect(feed.shelves.discovery).toEqual([]);
});
test.each([
    { direction: "new" as const },
    { mood: null },
    { surface: "home" as const },
])(
    "does not inject saved songs into neutral/Home/Discoveries: %j",
    async (change) => {
        const { service, loadSavedMoodCandidates } = setup();
        await service.getPersonalizedFeed({ ...request, ...change });
        expect(loadSavedMoodCandidates).not.toHaveBeenCalled();
    },
);
test("the saved mood reserve cannot bypass canonical dislikes", async () => {
    const { service, loadDislikedCanonicalKeys } = setup();
    loadDislikedCanonicalKeys.mockResolvedValue(new Set([saved.canonicalKey]));
    const feed = await service.getPersonalizedFeed(request);
    expect(Object.values(feed.shelves).flat()).toEqual([]);
});
test("the saved mood reserve cannot bypass current queue exclusions", async () => {
    const { service } = setup();
    const feed = await service.getPersonalizedFeed({
        ...request,
        excludeVideoIds: ["calm"],
    });
    expect(Object.values(feed.shelves).flat()).toEqual([]);
});
test("a failed optional reserve keeps normal recommendation delivery available", async () => {
    const { service, loadSavedMoodCandidates } = setup();
    loadSavedMoodCandidates.mockRejectedValue(
        new Error("database unavailable"),
    );
    const feed = await service.getPersonalizedFeed(request);
    expect(feed.degradedSources).toContain("saved-mood-candidates");
});
