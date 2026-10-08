import { UnifiedRecommendationService } from "../recommendationService";
import type { UnifiedRecommendationDependencies } from "../recommendationService";
import type { PersonalizedHomeFeed } from "../../personalizedCatalog";
import { toNativeRecommendationCandidate } from "../nativeCandidates";
import { toRadioContinuationTrack } from "../radioContinuation";

const now = new Date("2026-10-08T10:00:00Z");
function nativeRow(provider: "vk" | "yandex", id: string) {
    const recording = {
        provider,
        id,
        title: `Song ${id}`,
        artists: [`Band ${id}`, "Guest"],
        duration: 180,
        preview: false,
        contentVersion: "unknown",
    };
    const candidate = toNativeRecommendationCandidate(
        recording,
        "personal-test",
    )!;
    const track = toRadioContinuationTrack(candidate)!;
    return {
        ...track,
        trackNo: null,
        album: { ...track.album, coverArt: "", artist: track.artist },
    };
}
function feed(rows: unknown[]): PersonalizedHomeFeed {
    return {
        shelves: { listenAgain: [], quickPicks: [], discovery: rows as any[] },
        degraded: false,
        reason: null,
        seedCount: 1,
        nextCursor: 2,
    };
}
function ports(
    overrides: Partial<UnifiedRecommendationDependencies> = {},
): UnifiedRecommendationDependencies {
    return {
        mode: "baseline",
        hybridRolloutPercent: 100,
        explorationRate: 0,
        loadPersonalizedFeed: async () => feed([]),
        resolveCanonical: async () => null,
        loadCanonicalMappings: async (candidates) => candidates.map(() => null),
        loadRecentExposures: async () => [],
        loadDislikedCanonicalKeys: async () => new Set(),
        loadSavedCanonicalKeys: async () => new Set(),
        loadTasteContext: async () => ({
            positiveCentroids: [],
            negativeCentroids: [],
        }),
        recordGeneration: jest.fn(async () => "native-personal-generation"),
        scheduleHotSet: jest.fn(async () => {}),
        loadSimilarCandidates: async () => ({
            candidates: [],
            nextCursor: 0,
            degradedSources: [],
        }),
        now: () => now,
        ...overrides,
    };
}
const input = {
    userId: "owner-a",
    sessionId: "personal-tab",
    surface: "wave" as const,
    limit: 12,
    cursor: 1,
    direction: "for-you" as const,
    mood: null,
    excludeVideoIds: [],
};
describe("native personal facade delivery", () => {
    it.each(["baseline", "shadow", "active"] as const)(
        "%s keeps native DTO and exact served membership on every personal surface",
        async (mode) => {
            for (const provider of ["vk", "yandex"] as const)
                for (const surface of [
                    "home",
                    "wave",
                    "made-for-you",
                ] as const) {
                    const ids =
                        provider === "vk"
                            ? ["-01_0002", "-01_0003"]
                            : ["0002", "0003"];
                    const rows = ids.map((id) => nativeRow(provider, id));
                    const deps = ports({
                        mode,
                        loadPersonalizedFeed: async () => feed(rows),
                    });
                    const result = await new UnifiedRecommendationService(
                        deps,
                    ).getPersonalizedFeed({
                        ...input,
                        surface,
                        timeOfDay: surface === "made-for-you",
                        context: { localHour: 8, timezoneOffsetMinutes: 180 },
                    });
                    expect(
                        result.shelves.discovery
                            .map((track) => track.id)
                            .sort(),
                    ).toEqual(rows.map((track) => track.id).sort());
                    expect(
                        result.shelves.discovery.map((track) => track.source),
                    ).toEqual([provider, provider]);
                    for (const returned of result.shelves.discovery) {
                        const original = rows.find(
                            (row) => row.id === returned.id,
                        )!;
                        expect(returned).toEqual(
                            expect.objectContaining({
                                source: provider,
                                streamSource: provider,
                                musicSourceRecording:
                                    original.musicSourceRecording,
                                provider: {
                                    source: provider,
                                    providerTrackId:
                                        original.musicSourceRecording!.id,
                                    tidalTrackId: null,
                                    youtubeVideoId: null,
                                },
                            }),
                        );
                    }
                    expect(
                        result.shelves.discovery[0].youtubeVideoId,
                    ).toBeUndefined();
                    const served = (
                        deps.recordGeneration as jest.Mock
                    ).mock.calls.filter(([generation]) => generation.served);
                    expect(served).toHaveLength(1);
                    expect(
                        served[0][0].recommendations.map(
                            (row: any) => row.track.id,
                        ),
                    ).toEqual(
                        result.shelves.discovery.map((track) => track.id),
                    );
                    expect(served[0][0].userId).toBe("owner-a");
                }
        },
    );
    it("rejects reserved malformed tuples before generation without legacy substitution", async () => {
        const good = nativeRow("yandex", "0002");
        const deps = ports({
            loadPersonalizedFeed: async () =>
                feed([
                    {
                        ...good,
                        source: "youtube",
                        youtubeVideoId: "legacy-video",
                    },
                    { ...good, title: "Other recording" },
                    {
                        ...good,
                        provider: {
                            source: "vk",
                            providerTrackId: "-1_2",
                            youtubeVideoId: null,
                            tidalTrackId: null,
                        },
                    },
                ]),
        });
        const result = await new UnifiedRecommendationService(
            deps,
        ).getPersonalizedFeed(input);
        expect(Object.values(result.shelves).flat()).toEqual([]);
        expect(
            (deps.recordGeneration as jest.Mock).mock.calls[0][0]
                .recommendations,
        ).toEqual([]);
    });
    it("cancels a pending personal source before any generation or job, even when source completes late", async () => {
        let release!: (value: PersonalizedHomeFeed) => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const held = new Promise<PersonalizedHomeFeed>((resolve) => {
            release = resolve;
        });
        const deps = ports({
            loadPersonalizedFeed: async () => {
                entered();
                return held;
            },
        });
        const service = new UnifiedRecommendationService(deps);
        const controller = new AbortController();
        const run = (
            service.getPersonalizedFeed.bind(service) as (
                ...args: any[]
            ) => Promise<unknown>
        )(input, { signal: controller.signal });
        const outcome = run.then(
            () => "resolved",
            (error) => error.code,
        );
        await started;
        controller.abort(new Error("private caller reason"));
        const result = await Promise.race([
            outcome,
            new Promise((resolve) =>
                setTimeout(() => resolve("still-pending"), 100),
            ),
        ]);
        release(feed([nativeRow("vk", "-1_2")]));
        await outcome;
        await new Promise((resolve) => setImmediate(resolve));
        expect(result).toBe("RADIO_REQUEST_CANCELLED");
        expect(deps.recordGeneration).not.toHaveBeenCalled();
        expect(deps.scheduleHotSet).not.toHaveBeenCalled();
    });
});
