const mockSelectionPlayFindMany = jest.fn();
const mockSelectionExclusionFindMany = jest.fn();

jest.mock("../../../utils/db", () => ({
    prisma: {
        play: { findMany: mockSelectionPlayFindMany },
        discoverExclusion: { findMany: mockSelectionExclusionFindMany },
    },
}));
jest.mock("../discoverySeeding", () => ({ discoverySeeding: {} }));

import { DiscoveryRecommendationsService } from "../discoveryRecommendations";

const NOW = new Date("2026-10-08T04:00:00.000Z");
interface RecentPlay {
    userId: string;
    source: string;
    trackId: string | null;
    playedAt: Date;
}

function localPlay(overrides: Partial<RecentPlay> = {}): RecentPlay {
    return {
        userId: "alice",
        source: "LIBRARY",
        trackId: "local-row",
        playedAt: new Date(NOW.getTime() - 60_000),
        ...overrides,
    };
}

function useCorpus(plays: RecentPlay[]) {
    mockSelectionPlayFindMany.mockImplementation(
        async (query: {
            where: {
                userId: string;
                playedAt: { gte: Date };
                trackId?: { not: null };
            };
            take: number;
        }) =>
            plays
                .filter(
                    (row) =>
                        row.userId === query.where.userId &&
                        row.playedAt >= query.where.playedAt.gte &&
                        (!query.where.trackId || row.trackId !== null),
                )
                .slice(0, query.take),
    );
}

function readSelectionFilters(userId: string) {
    return new DiscoveryRecommendationsService()["getSelectionFilters"](userId);
}

describe("Discover Weekly local recent-play quota", () => {
    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(NOW);
        mockSelectionPlayFindMany.mockReset();
        mockSelectionExclusionFindMany.mockReset().mockResolvedValue([]);
    });

    afterEach(() => jest.useRealTimers());

    it("keeps a recent local exclusion behind 5000 direct-source rows", async () => {
        useCorpus([
            ...Array.from({ length: 5000 }, (_, index) =>
                localPlay({
                    source: index % 2 === 0 ? "VK" : "YANDEX",
                    trackId: null,
                }),
            ),
            localPlay(),
        ]);

        expect((await readSelectionFilters("alice")).recentTrackIds).toEqual([
            "local-row",
        ]);
    });

    it("keeps the owner and inclusive 14-day boundary before the quota", async () => {
        useCorpus([
            ...Array.from({ length: 5000 }, () =>
                localPlay({ userId: "bob", trackId: "another-owner" }),
            ),
            localPlay({
                trackId: "expired",
                playedAt: new Date(NOW.getTime() - 14 * 86_400_000 - 1),
            }),
            localPlay({
                trackId: "boundary",
                playedAt: new Date(NOW.getTime() - 14 * 86_400_000),
            }),
            localPlay({ source: "DISCOVERY_KEPT" }),
        ]);
        mockSelectionExclusionFindMany.mockResolvedValue([
            { albumMbid: "excluded-album" },
        ]);

        expect(await readSelectionFilters("alice")).toEqual({
            recentTrackIds: ["boundary", "local-row"],
            excludedAlbumMbids: ["excluded-album"],
        });
    });

    it("retains the 5000-row bound for local recent plays", async () => {
        useCorpus(Array.from({ length: 5001 }, () => localPlay()));

        expect(
            (await readSelectionFilters("alice")).recentTrackIds,
        ).toHaveLength(5000);
    });
});
