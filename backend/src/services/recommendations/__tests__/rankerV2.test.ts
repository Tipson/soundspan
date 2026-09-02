import { buildTasteCentroids, rankRecommendationCandidates } from "../rankerV2";
import type {
    RecommendationCandidate,
    RecommendationExposureSignal,
} from "../types";

function candidate(
    id: string,
    artist = `artist-${id}`,
    overrides: Partial<RecommendationCandidate> = {},
): RecommendationCandidate {
    return {
        id: `yt:${id}`,
        canonicalKey: `meta:${artist}:${id}:180`,
        title: id,
        duration: 180,
        artist: { id: null, name: artist },
        album: { id: null, title: `album-${id}`, coverArt: null },
        source: "youtube",
        provider: { tidalTrackId: null, youtubeVideoId: id },
        streamSource: "youtube",
        youtubeVideoId: id,
        candidateSources: ["youtube-radio"],
        providerPrior: 1,
        ...overrides,
    };
}

describe("recommendation ranker v2", () => {
    const now = new Date("2026-09-01T12:00:00.000Z");

    it("hard-excludes dislikes, canonical duplicates and recent exposures", () => {
        const exposures: RecommendationExposureSignal[] = [
            {
                canonicalKey: "meta:artist-recent:recent:180",
                exposedAt: new Date("2026-09-01T08:00:00.000Z"),
            },
        ];
        const ranked = rankRecommendationCandidates(
            [
                candidate("disliked"),
                candidate("recent", "artist-recent"),
                candidate("first", "artist-a", {
                    canonicalKey: "mbid:shared",
                }),
                candidate("duplicate", "artist-b", {
                    canonicalKey: "mbid:shared",
                    providerPrior: 0.5,
                }),
                candidate("fresh"),
            ],
            {
                now,
                limit: 10,
                sessionId: "session-a",
                direction: "for-you",
                mood: null,
                dislikedCanonicalKeys: new Set([
                    "meta:artist-disliked:disliked:180",
                ]),
                exposures,
                positiveCentroids: [],
                negativeCentroids: [],
            },
        );

        expect(ranked.map((item) => item.track.id)).toEqual([
            "yt:first",
            "yt:fresh",
        ]);
    });

    it.each([
        ["familiar", null],
        ["for-you", "forgotten"],
    ] as const)(
        "keeps the one-day repeat cooldown while a fresh candidate exists for direction %s and mood %s",
        (direction, mood) => {
            const recent = candidate("recent");
            const fresh = candidate("fresh");
            const ranked = rankRecommendationCandidates([recent, fresh], {
                now,
                limit: 10,
                sessionId: "session-cooldown",
                direction,
                mood,
                dislikedCanonicalKeys: new Set(),
                exposures: [
                    {
                        canonicalKey: recent.canonicalKey,
                        exposedAt: new Date("2026-09-01T08:00:00.000Z"),
                    },
                ],
                positiveCentroids: [],
                negativeCentroids: [],
            });

            expect(ranked.map((item) => item.track.id)).toEqual(["yt:fresh"]);
        },
    );

    it("deterministically relaxes only the one-day cooldown when every safe candidate is recent", () => {
        const recentA = candidate("recent-a", "same-artist", {
            canonicalKey: "mbid:recent-a",
            lane: "listenAgain",
        });
        const recentDuplicate = candidate(
            "recent-a-duplicate",
            "other-artist",
            {
                canonicalKey: recentA.canonicalKey,
                providerPrior: 0.5,
                lane: "listenAgain",
            },
        );
        const recentB = candidate("recent-b", "same-artist", {
            lane: "listenAgain",
        });
        const recentArtistOverflow = candidate("recent-c", "same-artist", {
            lane: "listenAgain",
        });
        const recentOtherLane = candidate("recent-d", "fresh-artist", {
            lane: "quickPicks",
        });
        const disliked = candidate("disliked", "disliked-artist", {
            lane: "quickPicks",
        });
        const unplayable = candidate("unplayable", "unplayable-artist", {
            provider: { tidalTrackId: null, youtubeVideoId: null },
            lane: "quickPicks",
        });
        const exposure = (item: RecommendationCandidate) => ({
            canonicalKey: item.canonicalKey,
            exposedAt: new Date("2026-09-01T08:00:00.000Z"),
        });
        const candidates = [
            recentA,
            recentDuplicate,
            recentB,
            recentArtistOverflow,
            recentOtherLane,
            disliked,
            unplayable,
        ];
        const options = {
            now,
            limit: 10,
            perLaneLimit: 2,
            sessionId: "stable-fallback-session",
            direction: "for-you" as const,
            mood: null,
            dislikedCanonicalKeys: new Set([disliked.canonicalKey]),
            exposures: candidates.map(exposure),
            positiveCentroids: [],
            negativeCentroids: [],
        };

        const first = rankRecommendationCandidates(candidates, options);
        const second = rankRecommendationCandidates(candidates, options);

        expect(second.map((item) => item.track.id)).toEqual(
            first.map((item) => item.track.id),
        );
        expect(first).toHaveLength(3);
        expect(first.some((item) => item.track.id === "yt:recent-d")).toBe(
            true,
        );
        expect(
            first.filter((item) => item.track.artist.name === "same-artist"),
        ).toHaveLength(2);
        expect(
            first.filter((item) => item.track.lane === "listenAgain"),
        ).toHaveLength(2);
        expect(first.some((item) => item.track.id === "yt:disliked")).toBe(
            false,
        );
        expect(
            first.some((item) => item.track.id === "yt:recent-a-duplicate"),
        ).toBe(false);
        expect(first.some((item) => item.track.id === "yt:unplayable")).toBe(
            false,
        );
    });

    it("keeps fresh picks first and backfills personalized lane capacity with recent safe tracks", () => {
        const fresh = candidate("fresh", "fresh-artist", {
            lane: "quickPicks",
            providerPrior: 0.1,
        });
        const recentA = candidate("recent-a", "artist-a", {
            lane: "listenAgain",
            providerPrior: 10,
        });
        const recentB = candidate("recent-b", "artist-b", {
            lane: "quickPicks",
            providerPrior: 10,
        });
        const ranked = rankRecommendationCandidates([recentA, recentB, fresh], {
            now,
            limit: 3,
            perLaneLimit: 2,
            sessionId: "mixed-fallback-session",
            direction: "for-you",
            mood: null,
            dislikedCanonicalKeys: new Set(),
            exposures: [recentA, recentB].map((item) => ({
                canonicalKey: item.canonicalKey,
                exposedAt: new Date("2026-09-01T08:00:00.000Z"),
            })),
            positiveCentroids: [],
            negativeCentroids: [],
        });

        expect(ranked).toHaveLength(3);
        expect(ranked[0].track.id).toBe("yt:fresh");
        expect(new Set(ranked.map((item) => item.track.id))).toEqual(
            new Set(["yt:fresh", "yt:recent-a", "yt:recent-b"]),
        );
    });

    it("penalizes seven-day repeats and caps artist dominance", () => {
        const repeat = candidate("repeat", "same-artist", {
            providerPrior: 2,
        });
        const ranked = rankRecommendationCandidates(
            [
                repeat,
                candidate("same-2", "same-artist", { providerPrior: 1.19 }),
                candidate("same-3", "same-artist", { providerPrior: 1.18 }),
                candidate("fresh-a", "fresh-a", { providerPrior: 1.2 }),
                candidate("fresh-b", "fresh-b", { providerPrior: 1.1 }),
            ],
            {
                now,
                limit: 5,
                sessionId: "session-b",
                direction: "for-you",
                mood: null,
                dislikedCanonicalKeys: new Set(),
                exposures: [
                    {
                        canonicalKey: repeat.canonicalKey,
                        exposedAt: new Date("2026-08-28T12:00:00.000Z"),
                    },
                ],
                positiveCentroids: [],
                negativeCentroids: [],
            },
        );

        expect(
            ranked.filter((item) => item.track.artist.name === "same-artist"),
        ).toHaveLength(2);
        expect(ranked[0].track.id).toBe("yt:fresh-a");
    });

    it("is deterministic per session while exploration changes across sessions", () => {
        const candidates = Array.from({ length: 12 }, (_, index) =>
            candidate(`track-${index}`, `artist-${index}`, {
                providerPrior: 1,
            }),
        );
        const options = {
            now,
            limit: 8,
            direction: "new" as const,
            mood: null,
            dislikedCanonicalKeys: new Set<string>(),
            exposures: [],
            positiveCentroids: [],
            negativeCentroids: [],
        };

        const first = rankRecommendationCandidates(candidates, {
            ...options,
            sessionId: "stable-session",
        }).map((item) => item.track.id);
        const second = rankRecommendationCandidates(candidates, {
            ...options,
            sessionId: "stable-session",
        }).map((item) => item.track.id);
        const other = rankRecommendationCandidates(candidates, {
            ...options,
            sessionId: "other-session",
        }).map((item) => item.track.id);

        expect(second).toEqual(first);
        expect(other).not.toEqual(first);
    });

    it("builds several normalized taste centers instead of one average", () => {
        const centers = buildTasteCentroids(
            [
                [1, 0, 0],
                [0.9, 0.1, 0],
                [0, 1, 0],
                [0.1, 0.9, 0],
                [0, 0, 1],
                [0, 0.1, 0.9],
            ],
            3,
        );

        expect(centers).toHaveLength(3);
        for (const center of centers) {
            const norm = Math.sqrt(
                center.reduce((sum, value) => sum + value ** 2, 0),
            );
            expect(norm).toBeCloseTo(1, 6);
        }
    });

    it("uses DCLAP text similarity as an independent mood signal", () => {
        const aligned = candidate("aligned", "artist-a", {
            embedding: [1, 0],
            providerPrior: 0.9,
        });
        const opposed = candidate("opposed", "artist-b", {
            embedding: [0, 1],
            providerPrior: 1,
        });

        const ranked = rankRecommendationCandidates([opposed, aligned], {
            now,
            limit: 2,
            sessionId: "session-mood-vector",
            direction: "for-you",
            mood: "focus",
            moodEmbedding: [1, 0],
            dislikedCanonicalKeys: new Set(),
            exposures: [],
            positiveCentroids: [],
            negativeCentroids: [],
        });

        expect(ranked.map((item) => item.track.id)).toEqual([
            "yt:aligned",
            "yt:opposed",
        ]);
    });

    it("reacts strongly to the latest session profile", () => {
        const aligned = candidate("aligned", "artist-a", {
            embedding: [1, 0],
            providerPrior: 0.5,
        });
        const staleTaste = candidate("stale", "artist-b", {
            embedding: [0, 1],
            providerPrior: 1.5,
        });
        const ranked = rankRecommendationCandidates([staleTaste, aligned], {
            now,
            limit: 2,
            sessionId: "session-fast-profile",
            direction: "for-you",
            mood: null,
            dislikedCanonicalKeys: new Set(),
            exposures: [],
            positiveCentroids: [],
            negativeCentroids: [],
            sessionPositiveEmbedding: [1, 0],
        });

        expect(ranked[0].track.id).toBe("yt:aligned");
    });

    it("reserves an explicit bounded slot for unfamiliar discovery", () => {
        const familiar = Array.from({ length: 5 }, (_, index) =>
            candidate(`familiar-${index}`, `artist-${index}`, {
                providerPrior: 10 - index,
                accountAffinity: 1,
                lane: "quickPicks",
            }),
        );
        const explorer = candidate("explore", "new-artist", {
            providerPrior: 0.01,
            accountAffinity: 0,
            lane: "discovery",
        });
        const ranked = rankRecommendationCandidates([...familiar, explorer], {
            now,
            limit: 4,
            sessionId: "session-explicit-exploration",
            direction: "for-you",
            mood: null,
            dislikedCanonicalKeys: new Set(),
            exposures: [],
            positiveCentroids: [],
            negativeCentroids: [],
            explorationRate: 0.25,
        });

        expect(ranked).toHaveLength(4);
        const explored = ranked.find(
            (entry) => entry.track.id === "yt:explore",
        );
        expect(explored).toBeDefined();
        expect(explored?.track.candidateSources).toContain("exploration");
    });

    it("keeps exploration canonically unique and within artist caps", () => {
        const familiar = Array.from({ length: 6 }, (_, index) =>
            candidate(`familiar-${index}`, `artist-${index}`, {
                providerPrior: 10 - index,
                accountAffinity: 1,
                lane: "quickPicks",
            }),
        );
        const blockedArtist = [
            candidate("known-a", "blocked-artist", {
                providerPrior: 20,
                accountAffinity: 1,
                lane: "quickPicks",
            }),
            candidate("known-b", "blocked-artist", {
                providerPrior: 19,
                accountAffinity: 1,
                lane: "quickPicks",
            }),
        ];
        const duplicateExplorer = candidate("duplicate", "blocked-artist", {
            providerPrior: 0.2,
            accountAffinity: 0,
            lane: "discovery",
        });
        const allowedExplorer = candidate("allowed", "new-artist", {
            providerPrior: 0.1,
            accountAffinity: 0,
            lane: "discovery",
        });
        const ranked = rankRecommendationCandidates(
            [
                ...blockedArtist,
                ...familiar,
                duplicateExplorer,
                { ...duplicateExplorer },
                allowedExplorer,
            ],
            {
                now,
                limit: 8,
                sessionId: "session-safe-exploration",
                direction: "for-you",
                mood: null,
                dislikedCanonicalKeys: new Set(),
                exposures: [],
                positiveCentroids: [],
                negativeCentroids: [],
                explorationRate: 0.3,
            },
        );

        expect(
            ranked.filter(
                (entry) => entry.track.artist.name === "blocked-artist",
            ),
        ).toHaveLength(2);
        expect(
            new Set(ranked.map((entry) => entry.track.canonicalKey)).size,
        ).toBe(ranked.length);
        expect(ranked.some((entry) => entry.track.id === "yt:allowed")).toBe(
            true,
        );
    });
});
