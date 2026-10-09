jest.mock("../../youtubeMusic", () => ({
    ytMusicService: { getRadio: jest.fn() },
}));
import { PersonalizedCatalogService } from "../../personalizedCatalog";
import {
    PersonalNativeCandidateService,
    type PersonalNativeCandidateDependencies,
} from "../personalNativeCandidates";
import { toNativeRecommendationCandidate } from "../nativeCandidates";

const now = new Date("2026-10-08T10:00:00Z");
function candidate(source: "vk" | "yandex", id: string) {
    return toNativeRecommendationCandidate(
        {
            provider: source,
            id,
            title: `Song ${id}`,
            artists: [`Artist ${id}`],
            duration: 180,
            preview: false,
            contentVersion: "unknown",
        },
        "test",
    )!;
}
function nativePorts(
    overrides: Partial<PersonalNativeCandidateDependencies> = {},
): PersonalNativeCandidateDependencies {
    return {
        loadOwnedSignals: async () => {
            const liked = [
                candidate("vk", "-01_0002"),
                candidate("yandex", "0002"),
            ];
            return {
                recent: [],
                liked,
                plays: [],
                knownIds: new Set(liked.map((row) => row.id)),
            };
        },
        loadExactDislikes: async () => new Set(),
        loadCredits: async () => new Set(),
        loadMappings: async (rows) => rows.map(() => null),
        loadCanonicalDislikes: async () => new Set(),
        loadViewed: async () => new Set(),
        loadRepeats: async () => ({ ids: new Set(), hardIds: new Set() }),
        loadKnownIds: async () => new Set(),
        enrich: async (rows) => rows,
        getNeighbours: jest.fn(async (source) => ({
            tracks: Array.from(
                { length: 100 },
                (_, i) =>
                    candidate(
                        source,
                        source === "vk" ? `-01_${i + 100}` : `${i + 100}`,
                    ).musicSourceRecording!,
            ),
            unavailable: [],
        })),
        ...overrides,
    };
}
function catalog(ports: PersonalNativeCandidateDependencies, youtube = false) {
    const getRadio = jest.fn(async () => ({
        tracks: [
            {
                videoId: "fresh-youtube",
                title: "Fresh YT",
                artist: "YT band",
                duration: 180,
            },
        ],
    }));
    const service = new PersonalizedCatalogService({
        loadSignals: async () => ({
            recentPlays: [],
            likedTracks: youtube
                ? [
                      {
                          id: "seed",
                          videoId: "seed-youtube",
                          title: "Seed YT",
                          artist: "YT band",
                          duration: 180,
                      },
                  ]
                : [],
            playlistTracks: [],
            dislikedEntityIds: [],
        }),
        loadDislikedEntityIds: async () => [],
        getRadio,
        getListenBrainzCandidates: async () => [],
        now: () => now,
        nativeCandidates: new PersonalNativeCandidateService(ports),
    } as any);
    return { service, getRadio };
}
describe("actual personalized catalog native producer integration", () => {
    it.each(["home", "wave", "made-for-you"] as const)(
        "%s serves eligible original native neighbours rather than returning an empty YouTube-only feed",
        async (surface) => {
            const deps = nativePorts({
                loadExactDislikes: async (_owner, ids) =>
                    new Set(
                        ids.filter(
                            (id) =>
                                /:(?:-01_)?1\d\d$/.test(id) &&
                                Number(id.split(/[_:]/).at(-1)) < 150,
                        ),
                    ),
            });
            const { service, getRadio } = catalog(deps);
            const feed = await service.getHomeFeed("owner-a", 25, {
                surface,
                ...(surface === "made-for-you"
                    ? {
                          listeningContext: {
                              localHour: 8,
                              timezoneOffsetMinutes: 180,
                          },
                      }
                    : {}),
            });
            expect(feed.seedCount).toBe(2);
            expect(feed.reason).toBeNull();
            expect(feed.shelves.discovery).toHaveLength(25);
            expect(
                new Set(feed.shelves.discovery.map((row) => row.source)),
            ).toEqual(new Set(["vk", "yandex"]));
            expect(
                feed.shelves.discovery.every(
                    (row) => Number(row.id.split(/[_:]/).at(-1)) >= 150,
                ),
            ).toBe(true);
            for (const row of feed.shelves.discovery) {
                expect(row.provider.youtubeVideoId).toBeNull();
                expect(row).not.toHaveProperty("youtubeVideoId");
                expect(row).toHaveProperty("musicSourceRecording");
            }
            expect(getRadio).not.toHaveBeenCalled();
            expect(deps.getNeighbours).toHaveBeenCalledTimes(2);
        },
    );
    it("shares three radio seed calls across YouTube/VK/Yandex without extra source fanout", async () => {
        const deps = nativePorts(),
            { service, getRadio } = catalog(deps, true);
        const feed = await service.getHomeFeed("owner-a", 12, {
            surface: "wave",
        });
        expect(feed.seedCount).toBe(3);
        expect(
            getRadio.mock.calls.length +
                (deps.getNeighbours as jest.Mock).mock.calls.length,
        ).toBe(3);
        expect(getRadio).toHaveBeenCalledTimes(1);
        expect(deps.getNeighbours).toHaveBeenCalledTimes(2);
        expect(
            new Set(feed.shelves.discovery.map((row) => row.source)),
        ).toEqual(new Set(["youtube", "vk", "yandex"]));
    });
    it("reports partial failure when native discovery survives unavailable YouTube radio", async () => {
        const deps = nativePorts(),
            { service, getRadio } = catalog(deps, true);
        getRadio.mockRejectedValueOnce(new Error("radio unavailable"));
        const feed = await service.getHomeFeed("owner-a", 12, {
            surface: "wave",
        });
        expect(feed.shelves.discovery).toHaveLength(12);
        expect(feed.degraded).toBe(true);
        expect(feed.reason).toBe("provider_partial_failure");
    });
    it("does not use old native fallback while any source has fresh eligible results", async () => {
        const old = candidate("vk", "-1_20");
        const deps = nativePorts({
            loadOwnedSignals: async () => ({
                recent: [old],
                liked: [old],
                plays: [],
                knownIds: new Set([old.id]),
            }),
            loadRepeats: async () => ({
                ids: new Set([old.id]),
                hardIds: new Set(),
            }),
            getNeighbours: async () => ({ tracks: [], unavailable: [] }),
        });
        const { service } = catalog(deps, true);
        const feed = await service.getHomeFeed("owner-a", 12, {
            surface: "wave",
        });
        expect(feed.shelves.discovery.map((row) => row.id)).toContain(
            "yt:fresh-youtube",
        );
        expect(
            Object.values(feed.shelves)
                .flat()
                .some((row) => row.id === old.id),
        ).toBe(false);
        const empty = catalog(deps).service;
        const fallback = await empty.getHomeFeed("owner-a", 12, {
            surface: "wave",
        });
        expect(fallback.shelves.listenAgain.map((row) => row.id)).toEqual([
            old.id,
        ]);
    });
});
