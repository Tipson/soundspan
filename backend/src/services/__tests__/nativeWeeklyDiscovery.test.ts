jest.mock("../youtubeMusic", () => ({
    ytMusicService: { getRadio: jest.fn() },
}));
import {
    PrismaWeeklyDiscoveryStore,
    weeklyDiscoveryTrackSchema,
    type WeeklyDiscoveryTrack,
} from "../weeklyDiscoveryStore";
import {
    PersonalWeeklyDiscoveryService,
    type PersonalWeeklyDiscoveryDependencies,
} from "../personalWeeklyDiscovery";
import { toNativeRecommendationCandidate } from "../recommendations/nativeCandidates";
function row(i: number, source: "vk" | "yandex" = "vk"): any {
    const candidate = toNativeRecommendationCandidate(
        {
            provider: source,
            id: source === "vk" ? `-01_${i}` : `00${i}`,
            title: `Song ${i}`,
            artists: [`Band ${i}`, "Guest"],
            duration: 180,
            preview: false,
            contentVersion: "unknown",
        },
        "fixture",
    )!;
    return {
        id: candidate.id,
        title: candidate.title,
        artist: candidate.artist.name,
        album: "",
        albumId: candidate.id,
        duration: 180,
        coverUrl: null,
        sourceType: source,
        streamSource: source,
        musicSourceRecording: candidate.musicSourceRecording,
        provider: candidate.provider,
        available: true,
        isLiked: false,
        likedAt: null,
        similarity: 0,
        tier: "explore",
    };
}
const week = "2026-10-05T00:00:00.000Z";
it("saves a strict native snapshot with exact ordered exposures and reads legacy v1", async () => {
    let saved: any = null;
    const create = jest.fn(async ({ data }) => {
        saved = { id: "saved", context: data.context };
        return saved;
    });
    const model = { findFirst: jest.fn(async () => saved), create };
    const store = new PrismaWeeklyDiscoveryStore({
        recommendationGeneration: model,
        $transaction: async (fn: any) =>
            fn({ recommendationGeneration: model }),
    } as any);
    const tracks = Array.from({ length: 20 }, (_, i) =>
        row(i + 100, i % 2 ? "vk" : "yandex"),
    );
    const result = await store.save("owner", week, tracks, 10);
    expect(result.tracks).toEqual(tracks);
    expect(
        create.mock.calls[0][0].data.exposures.create.map((e: any) => [
            e.provider,
            e.providerTrackId,
            e.canonicalKey,
            e.position,
        ]),
    ).toEqual(
        tracks.map((t, position) => [
            t.sourceType,
            t.musicSourceRecording.id,
            `provider:${t.id}`,
            position,
        ]),
    );
    expect((await store.find("owner", week))?.tracks).toEqual(tracks);
    saved = {
        id: "legacy",
        context: {
            weeklyDiscovery: {
                version: 1,
                weekStart: week,
                cleared: true,
                tracks: [],
            },
        },
    };
    expect((await store.find("owner", week))?.cleared).toBe(true);
});
it("rejects malformed native tuples/private recording fields before storage", () => {
    const good = row(100);
    expect(weeklyDiscoveryTrackSchema.safeParse(good).success).toBe(true);
    for (const bad of [
        { ...good, sourceType: "youtube", youtubeVideoId: "fallback" },
        { ...good, provider: { ...good.provider, providerTrackId: "-01_999" } },
        { ...good, artist: "Reordered" },
        {
            ...good,
            musicSourceRecording: {
                ...good.musicSourceRecording,
                url: "https://private.example",
            },
        },
    ])
        expect(weeklyDiscoveryTrackSchema.safeParse(bad).success).toBe(false);
});
it("uses exact source identity for weekly novelty and applies fresh native feedback on a cached read", async () => {
    let saved: any = null,
        down = new Set<string>();
    const tracks = Array.from({ length: 40 }, (_, i) =>
        row(i + 100, i % 2 ? "vk" : "yandex"),
    );
    const deps: PersonalWeeklyDiscoveryDependencies = {
        store: {
            find: async () => saved,
            save: async (
                _owner: string,
                weekStart: string,
                rows: WeeklyDiscoveryTrack[],
            ) =>
                (saved = {
                    id: "generation",
                    weekStart,
                    cleared: false,
                    tracks: rows,
                }),
            clear: async () => 0,
        },
        getCandidates: async () => tracks,
        loadNoveltyExclusions: async () => new Set([tracks[0].id]),
        loadDislikedIds: async () => new Set(),
        loadSuppressedArtistKeys: async () => new Set(),
        filterNativeCandidates: async (
            _owner: string,
            rows: WeeklyDiscoveryTrack[],
        ) => rows.filter((t) => !down.has(t.id)),
        now: () => new Date("2026-10-08T10:00:00Z"),
    } as any;
    const service = new PersonalWeeklyDiscoveryService(deps);
    const fresh = await service.getCurrent("owner");
    expect(fresh.count).toBe(39);
    expect(fresh.tracks.map((t) => t.id)).not.toContain(tracks[0].id);
    down.add(tracks[1].id);
    const cached = await service.getCurrent("owner");
    expect(cached.count).toBe(38);
    expect(cached.tracks.map((t) => t.id)).not.toContain(tracks[1].id);
    expect(cached.generationId).toBe(fresh.generationId);
});
