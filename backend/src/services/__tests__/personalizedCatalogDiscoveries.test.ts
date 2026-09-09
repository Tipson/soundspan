jest.mock("../youtubeMusic", () => ({ ytMusicService: {} }));
jest.mock("../../utils/db", () => ({ prisma: {} }));
jest.mock("../recommendations/listenBrainzAdapter", () => ({
    listenBrainzRecommendationAdapter: {},
}));

import {
    PersonalizedCatalogService,
    type PersonalizedCatalogSignals,
} from "../personalizedCatalog";

function track(videoId: string, artist = `Artist ${videoId}`) {
    return {
        id: `row-${videoId}`,
        videoId,
        title: `Song ${videoId}`,
        artist,
        album: "Album",
        duration: 180,
        thumbnailUrl: null,
    };
}

function service(includeFresh: boolean) {
    const likedTracks = Array.from({ length: 4 }, (_, i) =>
        track(`liked-${i}`),
    );
    const signals: PersonalizedCatalogSignals = {
        recentPlays: [],
        likedTracks,
        playlistTracks: [],
        dislikedEntityIds: [],
    };
    return new PersonalizedCatalogService({
        loadSignals: async () => signals,
        loadDislikedEntityIds: async () => [],
        getRadio: jest.fn().mockResolvedValue({
            tracks: [
                likedTracks[3],
                ...(includeFresh
                    ? [track("unheard", likedTracks[0].artist)]
                    : []),
            ],
        }),
        getListenBrainzCandidates: async () => [],
    });
}

describe("Discoveries never backfills with a known recording", () => {
    it("allows an unheard song by a saved artist, but not another saved song", async () => {
        const result = await service(true).getHomeFeed("listener", 2, {
            mode: "new",
        });
        expect(result.shelves.discovery.map((t) => t.youtubeVideoId)).toEqual([
            "unheard",
        ]);
    });

    it("returns an empty discovery lane when the provider only has known songs", async () => {
        const result = await service(false).getHomeFeed("listener", 2, {
            mode: "new",
        });
        expect(result.shelves.discovery).toEqual([]);
    });

    it("preserves known recordings in Familiar mode", async () => {
        const result = await service(false).getHomeFeed("listener", 2, {
            mode: "familiar",
        });
        expect(result.shelves.discovery.map((t) => t.youtubeVideoId)).toEqual([
            "liked-3",
        ]);
    });
});
