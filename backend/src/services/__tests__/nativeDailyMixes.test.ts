const mockCreate = jest.fn(async (..._args: unknown[]) => ({
    id: "native-daily-generation",
}));
jest.mock("../../utils/db", () => ({
    prisma: {
        recommendationGeneration: {
            create: (...args: unknown[]) => mockCreate(...args),
        },
    },
}));
jest.mock("../youtubeMusic", () => ({
    ytMusicService: { getRadio: jest.fn() },
}));
jest.mock("../lastfm", () => ({ lastFmService: {} }));
import {
    PersonalDailyMixService,
    personalDailyMixService,
    type PersonalDailyMixDependencies,
} from "../personalDailyMixes";
import {
    PersonalNativeCandidateService,
    toNativePersonalizedTrack,
    type PersonalNativeCandidateDependencies,
} from "../recommendations/personalNativeCandidates";
import { toNativeRecommendationCandidate } from "../recommendations/nativeCandidates";
const now = new Date("2026-10-08T12:00:00Z");
const song = (id: string) =>
    toNativeRecommendationCandidate(
        {
            provider: "vk",
            id,
            title: `Song ${id}`,
            artists: [`Band ${id}`, "Guest"],
            duration: 180,
            preview: false,
            contentVersion: "unknown",
        },
        "fixture",
    )!;
const seeds = [song("-01_1"), song("-01_2")];
function ports(
    overrides: Partial<PersonalNativeCandidateDependencies> = {},
): PersonalNativeCandidateDependencies {
    return {
        loadOwnedSignals: async () => ({
            recent: [],
            liked: seeds,
            plays: [],
            knownIds: new Set(seeds.map((t) => t.id)),
        }),
        loadExactDislikes: async () => new Set(),
        loadCredits: async () => new Set(),
        loadMappings: async (rows) => rows.map(() => null),
        loadCanonicalDislikes: async () => new Set(),
        loadViewed: async () => new Set(),
        loadRepeats: async () => ({ ids: new Set(), hardIds: new Set() }),
        loadKnownIds: async () => new Set(),
        enrich: async (rows) => rows,
        getNeighbours: jest.fn(async (_provider, id) => ({
            tracks: Array.from(
                { length: 100 },
                (_, i) =>
                    song(`-01_${Number(id.split("_")[1]) * 1000 + i}`)
                        .musicSourceRecording!,
            ),
            unavailable: [],
        })),
        ...overrides,
    };
}
function dependencies(
    native: PersonalNativeCandidateService,
): PersonalDailyMixDependencies {
    return {
        loadDirections: async () => [],
        loadFamiliar: async () => [],
        loadRecentlyPlayed: async () => [],
        loadGenreArtists: async () => [],
        searchSongs: async () => [],
        getRadio: jest.fn(async () => []),
        loadDislikedIds: async () => new Set(),
        loadDislikeState: async () => "0",
        loadSuppressedArtistKeys: async () => new Set(),
        recordMixGeneration: jest.fn(async () => "generation"),
        nativeCandidates: native,
        now: () => now,
    } as any;
}
it("builds actual native daily mixes of20–40 tracks with no overlap, current feedback and exact DTO", async () => {
    let downs = new Set<string>(),
        state = "0";
    const native = ports({
            loadExactDislikes: async (_owner, ids) =>
                new Set(ids.filter((id) => downs.has(id))),
        }),
        deps = dependencies(new PersonalNativeCandidateService(native));
    deps.loadDislikeState = async () => state;
    const service = new PersonalDailyMixService(deps);
    const result = await service.getMixes("owner");
    expect(result.mixes).toHaveLength(2);
    for (const mix of result.mixes) {
        expect(mix.tracks.length).toBeGreaterThanOrEqual(20);
        expect(mix.tracks.length).toBeLessThanOrEqual(40);
        expect(mix.tracks.every((t) => t.source === "vk")).toBe(true);
    }
    const ids = result.mixes.flatMap((m) => m.tracks.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
    await service.getMixes("owner");
    expect(native.getNeighbours).toHaveBeenCalledTimes(2);
    const blocked = ids.find((id) => !seeds.some((seed) => seed.id === id))!;
    downs.add(blocked);
    state = "1";
    const refreshed = await service.getMixes("owner");
    expect(
        refreshed.mixes.flatMap((m) => m.tracks.map((t) => t.id)),
    ).not.toContain(blocked);
    expect(native.getNeighbours).toHaveBeenCalledTimes(4);
    expect(deps.getRadio).not.toHaveBeenCalled();
});
it("writes ordered native daily exposures without borrowing a YouTube ID", async () => {
    mockCreate.mockClear();
    const tracks = Array.from(
        { length: 20 },
        (_, i) => toNativePersonalizedTrack(song(`-01_${100 + i}`))!,
    );
    await (personalDailyMixService as any).dependencies.recordMixGeneration({
        userId: "owner",
        mix: { key: "native", title: "Native", description: "", tracks },
        generatedAt: now,
        latencyMs: 1,
    });
    const exposures = (mockCreate.mock.calls[0] as any)[0].data.exposures
        .create;
    expect(
        exposures.map((e: any) => [
            e.provider,
            e.providerTrackId,
            e.canonicalKey,
            e.position,
        ]),
    ).toEqual(
        tracks.map((t, i) => [
            "vk",
            t.provider.providerTrackId,
            `provider:${t.id}`,
            i,
        ]),
    );
});
it.each(["canonical-down", "viewed"])(
    "revalidates cached native neighbours when a confirmed mapping becomes %s",
    async (reason) => {
        let blocked: string | null = null;
        const native = ports({
            loadMappings: async (rows) =>
                rows.map((row) =>
                    row.id === blocked
                        ? { id: "live-blocked", canonicalKey: "strong-blocked" }
                        : null,
                ),
            loadCanonicalDislikes: async () =>
                new Set(reason === "canonical-down" ? ["strong-blocked"] : []),
            loadViewed: async () =>
                new Set(reason === "viewed" ? ["strong-blocked"] : []),
        });
        const deps = dependencies(new PersonalNativeCandidateService(native));
        const service = new PersonalDailyMixService(deps);
        const first = await service.getMixes("owner");
        blocked = first.mixes
            .flatMap((mix) => mix.tracks)
            .find((track) => !seeds.some((seed) => seed.id === track.id))!.id;
        const second = await service.getMixes("owner");
        expect(
            second.mixes.flatMap((mix) => mix.tracks.map((track) => track.id)),
        ).not.toContain(blocked);
        expect(second.mixes.every((mix) => mix.tracks.length >= 20)).toBe(true);
        expect(native.getNeighbours).toHaveBeenCalledTimes(4);
    },
);
it("rejects contradictory native identity before any daily generation write", async () => {
    mockCreate.mockClear();
    const original = toNativePersonalizedTrack(song("-01_100"))!;
    for (const track of [
        {
            ...original,
            provider: { ...original.provider, providerTrackId: "-01_101" },
        },
        { ...original, youtubeVideoId: "borrowed-yt" },
        { ...original, streamSource: "youtube" },
        { ...original, musicSourceRecording: null },
    ]) {
        await expect(
            (personalDailyMixService as any).dependencies.recordMixGeneration({
                userId: "owner",
                mix: {
                    key: "native",
                    title: "Native",
                    description: "",
                    tracks: [track],
                },
                generatedAt: now,
                latencyMs: 1,
            }),
        ).rejects.toThrow();
    }
    expect(mockCreate).not.toHaveBeenCalled();
});
it("recovers immediately after transient native policy reads fail instead of caching an empty mix", async () => {
    let failed = false;
    const native = ports({
        loadMappings: async (rows) => {
            if (
                failed &&
                rows.some((row) => !seeds.some((seed) => seed.id === row.id))
            )
                throw new Error("mapping read unavailable");
            return rows.map(() => null);
        },
    });
    const service = new PersonalDailyMixService(
        dependencies(new PersonalNativeCandidateService(native)),
    );
    expect((await service.getMixes("owner")).mixes).toHaveLength(2);
    failed = true;
    expect((await service.getMixes("owner")).mixes).toHaveLength(0);
    failed = false;
    expect((await service.getMixes("owner")).mixes).toHaveLength(2);
    expect(native.getNeighbours).toHaveBeenCalledTimes(6);
});
