import { UnifiedRecommendationService } from "../recommendationService";
import type { RecommendationCandidate } from "../types";
import type {
    PersonalizedHomeFeed,
    PersonalizedTrack,
} from "../../personalizedCatalog";

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
function setup(now = () => new Date()) {
    const loadSavedMoodCandidates = jest.fn().mockResolvedValue([saved]);
    const loadDislikedCanonicalKeys = jest.fn().mockResolvedValue(new Set());
    const loadRecentExposures = jest.fn().mockResolvedValue([]);
    const loadPersonalizedFeed = jest.fn(
        async (): Promise<PersonalizedHomeFeed> => ({
            shelves: { listenAgain: [], quickPicks: [], discovery: [] },
            degraded: false,
            reason: null,
            seedCount: 1,
            nextCursor: 1,
        }),
    );
    const deps = {
        mode: "active" as const,
        hybridRolloutPercent: 100,
        explorationRate: 0,
        loadSavedMoodCandidates,
        loadPersonalizedFeed,
        resolveCanonical: async (c: RecommendationCandidate) => ({
            id: c.canonicalRecordingId!,
            canonicalKey: c.canonicalKey,
        }),
        loadRecentExposures,
        loadDislikedCanonicalKeys,
        loadTasteContext: async () => ({
            positiveCentroids: [],
            negativeCentroids: [],
        }),
        recordGeneration: async () => "g",
        scheduleHotSet: async () => {},
        loadSimilarCandidates: jest.fn(),
        now,
    };
    return {
        service: new UnifiedRecommendationService(deps),
        loadSavedMoodCandidates,
        loadDislikedCanonicalKeys,
        loadPersonalizedFeed,
        deps,
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

test.each(["baseline", "active", "shadow"] as const)(
    "fills the mood lane across a slow catalog's 24h boundary in %s",
    async (mode) => {
        const started = new Date("2026-10-08T00:00:00Z");
        const viewedAt = new Date(+started - 86_400_000 + 1_000);
        const clock = jest.fn().mockReturnValue(new Date(+started + 5_000));
        clock.mockReturnValueOnce(started);
        const { deps, loadSavedMoodCandidates } = setup(clock);
        const pool = Array.from({ length: 56 }, (_, index) => ({
            ...saved,
            id: `yt:clock-${index}`,
            canonicalRecordingId: `clock-${index}`,
            canonicalKey: `clock-${index}`,
            artist: { id: null, name: `Artist ${index}` },
            provider: { tidalTrackId: null, youtubeVideoId: `clock-${index}` },
            youtubeVideoId: `clock-${index}`,
        }));
        deps.loadRecentExposures.mockResolvedValue(
            pool.slice(0, 40).map((track) => ({
                canonicalKey: track.canonicalKey,
                exposedAt: viewedAt,
            })),
        );
        loadSavedMoodCandidates.mockImplementation(
            async (_user, _mood, options) =>
                pool
                    .filter(
                        (_track, index) =>
                            index >= 40 ||
                            +viewedAt <= +options.now - 86_400_000,
                    )
                    .slice(0, 48),
        );
        const service = new UnifiedRecommendationService({ ...deps, mode });
        const feed = await service.getPersonalizedFeed(request);
        expect(feed.shelves.quickPicks).toHaveLength(12);
        expect(
            feed.shelves.quickPicks.every(
                (track) => Number(track.youtubeVideoId.split("-")[1]) >= 40,
            ),
        ).toBe(true);
    },
);
test("mood can reach saved songs outside the pre-truncated provider shelves", async () => {
    const { service, loadSavedMoodCandidates } = setup();
    const feed = await service.getPersonalizedFeed(request);
    expect(loadSavedMoodCandidates).toHaveBeenCalledWith(
        "alice",
        "calm",
        expect.objectContaining({
            allowRecentListeningFallback: true,
            now: expect.any(Date),
        }),
    );
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

test.each(["listenAgain", "quickPicks", "discovery"] as const)(
    "does not relax recent-listening exclusions when the catalog has a %s candidate",
    async (lane) => {
        const { service, loadSavedMoodCandidates, loadPersonalizedFeed } =
            setup();
        const track: PersonalizedTrack = {
            id: saved.id,
            title: saved.title,
            duration: saved.duration,
            trackNo: null,
            source: "youtube",
            streamSource: "youtube",
            youtubeVideoId: "calm",
            provider: { tidalTrackId: null, youtubeVideoId: "calm" },
            artist: saved.artist,
            album: {
                ...saved.album,
                coverArt: "https://example.com/cover.jpg",
                artist: saved.artist,
            },
        };
        loadPersonalizedFeed.mockResolvedValue({
            shelves: {
                listenAgain: [],
                quickPicks: [],
                discovery: [],
                [lane]: [track],
            },
            degraded: false,
            reason: null,
            seedCount: 1,
            nextCursor: 1,
        });
        await service.getPersonalizedFeed(request);
        expect(loadSavedMoodCandidates).toHaveBeenCalledWith(
            "alice",
            "calm",
            expect.objectContaining({ allowRecentListeningFallback: false }),
        );
    },
);
