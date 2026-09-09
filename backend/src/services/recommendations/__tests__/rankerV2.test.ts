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

    it.each([2, 500])(
        "bounds centroid reuse by entry count and key storage (%i vectors)",
        (size) => {
            jest.isolateModules(() => {
                const build = (
                    require("../rankerV2") as typeof import("../rankerV2")
                ).buildTasteCentroids;
                const input = (variant: number) =>
                    Array.from({ length: size }, () =>
                        Array.from({ length: 512 }, (_, axis) =>
                            axis === 0 ? variant + 1 : axis === 1 ? 1 : 0,
                        ),
                    );
                const entries = size === 2 ? 33 : 7;
                for (let variant = 0; variant < entries; variant += 1)
                    build(input(variant), 1);
                const forEach = jest.spyOn(Array.prototype, "forEach");
                try {
                    build(input(entries - 1), 1);
                    expect(forEach).not.toHaveBeenCalled();
                    build(input(0), 1);
                    expect(forEach).toHaveBeenCalled();
                } finally {
                    forEach.mockRestore();
                }
            });
        },
    );

    it("reuses identical centroid arithmetic with copy isolation and content invalidation", () => {
        jest.isolateModules(() => {
            const build = (
                require("../rankerV2") as typeof import("../rankerV2")
            ).buildTasteCentroids;
            const vectors = Array.from({ length: 20 }, (_, row) =>
                Array.from({ length: 512 }, (_, axis) =>
                    Math.sin(row + axis + 1),
                ),
            );
            const expected = build(vectors, 3);
            const forEach = jest.spyOn(Array.prototype, "forEach");
            let actual: number[][];
            let calls = 0;
            try {
                actual = build(
                    vectors.map((v) => [...v]),
                    3,
                );
                calls = forEach.mock.calls.length;
            } finally {
                forEach.mockRestore();
            }
            expect(actual!).toEqual(expected);
            expect(calls).toBe(0);
            actual![0][0] = 999;
            expect(build(vectors, 3)).toEqual(expected);
            expect(build(vectors, 2)).toHaveLength(2);
            vectors[0][0] += 10;
            expect(build(vectors, 3)).not.toEqual(expected);
        });
    });

    it("normalizes shared mood and session vectors once for the entire rank", () => {
        const dimension = 32;
        let reads = 0;
        const shared = () =>
            new Proxy(
                Array.from({ length: dimension }, (_, i) => i + 1),
                {
                    get(target, key, receiver) {
                        if (typeof key === "string" && /^\d+$/.test(key))
                            reads += 1;
                        return Reflect.get(target, key, receiver);
                    },
                },
            );
        const tracks = Array.from({ length: 30 }, (_, index) =>
            candidate(`shared-${index}`, `artist-${index}`, {
                embedding: Array.from({ length: dimension }, (_, i) =>
                    Math.sin(index + i + 1),
                ),
            }),
        );
        const ranked = rankRecommendationCandidates(tracks, {
            now,
            limit: 12,
            sessionId: "shared-audio",
            direction: "for-you",
            mood: "calm",
            dislikedCanonicalKeys: new Set(),
            exposures: [],
            positiveCentroids: [],
            negativeCentroids: [],
            moodEmbedding: shared(),
            sessionPositiveEmbedding: shared(),
            sessionNegativeEmbedding: shared(),
        });
        expect(ranked).toHaveLength(12);
        expect(reads).toBeLessThanOrEqual(3 * dimension * 2);
    });

    it("validates and normalizes a taste vector in at most two coordinate passes", () => {
        const values = Array.from({ length: 512 }, (_, index) => index + 1);
        let reads = 0;
        const vector = new Proxy(values, {
            get(target, key, receiver) {
                if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
                return Reflect.get(target, key, receiver);
            },
        });
        const centers = buildTasteCentroids([vector], 1);
        expect(centers).toHaveLength(1);
        expect(centers[0]).toHaveLength(values.length);
        expect(Math.hypot(...centers[0])).toBeCloseTo(1, 12);
        expect(reads).toBeLessThanOrEqual(values.length * 2);
        expect(values[0]).toBe(1);
        expect(values[511]).toBe(512);
    });

    it("reads each audio vector a bounded number of times while diversifying a full queue", () => {
        let reads = 0;
        const dimension = 64;
        const tracks = Array.from({ length: 60 }, (_, index) =>
            candidate(`bounded-${index}`, `artist-${index}`, {
                embedding: new Proxy(
                    Array.from({ length: dimension }, (_, axis) =>
                        Math.sin(index * dimension + axis + 1),
                    ),
                    {
                        get(target, key, receiver) {
                            if (typeof key === "string" && /^\d+$/.test(key))
                                reads += 1;
                            return Reflect.get(target, key, receiver);
                        },
                    },
                ),
            }),
        );
        const ranked = rankRecommendationCandidates(tracks, {
            now,
            limit: 36,
            sessionId: "bounded-audio",
            direction: "for-you",
            mood: null,
            dislikedCanonicalKeys: new Set(),
            exposures: [],
            positiveCentroids: [],
            negativeCentroids: [],
        });
        expect(ranked).toHaveLength(36);
        expect(new Set(ranked.map(({ track }) => track.id)).size).toBe(36);
        expect(reads).toBeLessThanOrEqual(tracks.length * dimension * 12);
    });

    it("indexes canonical exposure history once across cooldown, scoring and exploration", () => {
        let canonicalReads = 0;
        const exposures = Array.from({ length: 500 }, (_, index) => ({
            get canonicalKey() {
                canonicalReads += 1;
                return `mbid:history-${index}`;
            },
            exposedAt: new Date(now.getTime() - 60_000),
        }));
        const candidates = Array.from({ length: 50 }, (_, index) =>
            candidate(`index-${index}`, `artist-${index}`, {
                canonicalKey: `mbid:history-${index}`,
                lane: index % 2 ? "quickPicks" : "discovery",
            }),
        );
        const ranked = rankRecommendationCandidates(candidates, {
            now,
            limit: 12,
            perLaneLimit: 8,
            sessionId: "indexed-history",
            direction: "for-you",
            mood: null,
            dislikedCanonicalKeys: new Set(),
            exposures,
            positiveCentroids: [],
            negativeCentroids: [],
            explorationRate: 0.3,
        });
        expect(ranked).toHaveLength(12);
        expect(canonicalReads).toBeLessThanOrEqual(exposures.length);
    });

    it.each([
        ["future", [new Date(now.getTime() + 60_000)], []],
        [
            "exactly one day",
            [new Date(now.getTime() - 86_400_000)],
            [1 - 12 / 7],
        ],
        ["exactly seven days", [new Date(now.getTime() - 7 * 86_400_000)], [1]],
        ["before epoch", [new Date(-1)], [1]],
        ["invalid then valid", [new Date(Number.NaN), now], [1]],
        ["valid then invalid", [now, new Date(Number.NaN)], [1]],
        [
            "duplicates newest last",
            [new Date(now.getTime() - 7 * 86_400_000), now],
            [],
        ],
        [
            "duplicates newest first",
            [now, new Date(now.getTime() - 7 * 86_400_000)],
            [],
        ],
    ] as const)(
        "preserves existing canonical recency semantics: %s",
        (_label, dates, scores) => {
            const item = candidate("history-boundary");
            const ranked = rankRecommendationCandidates(
                [item, candidate("fresh")],
                {
                    now,
                    limit: 2,
                    sessionId: "history-boundary",
                    direction: "familiar",
                    mood: null,
                    dislikedCanonicalKeys: new Set(),
                    exposures: dates.map((exposedAt) => ({
                        canonicalKey: item.canonicalKey,
                        exposedAt,
                    })),
                    positiveCentroids: [],
                    negativeCentroids: [],
                },
            );
            const actual = ranked
                .filter(({ track }) => track.id === item.id)
                .map(({ score }) => score);
            expect(actual).toHaveLength(scores.length);
            actual.forEach((score, index) =>
                expect(score).toBeCloseTo(scores[index], 12),
            );
        },
    );

    it.each([
        ["unseen", null, true],
        ["invalid date", new Date(Number.NaN), true],
        ["future date", new Date(now.getTime() + 60_000), false],
        ["old exposure", new Date(now.getTime() - 8 * 86_400_000), false],
    ] as const)(
        "preserves exploration eligibility for %s",
        (_label, exposedAt, expected) => {
            const explorer = candidate("explorer", "unknown-artist", {
                providerPrior: 0.01,
                accountAffinity: 0,
                lane: "discovery",
            });
            const familiar = Array.from({ length: 5 }, (_, index) =>
                candidate(`known-${index}`, `known-artist-${index}`, {
                    providerPrior: 10,
                    accountAffinity: 1,
                    lane: "quickPicks",
                }),
            );
            const ranked = rankRecommendationCandidates(
                [...familiar, explorer],
                {
                    now,
                    limit: 4,
                    sessionId: "exploration-index-compatibility",
                    direction: "familiar",
                    mood: null,
                    dislikedCanonicalKeys: new Set(),
                    exposures:
                        exposedAt === null
                            ? []
                            : [
                                  {
                                      canonicalKey: explorer.canonicalKey,
                                      exposedAt,
                                  },
                              ],
                    positiveCentroids: [],
                    negativeCentroids: [],
                    explorationRate: 0.25,
                },
            );
            expect(ranked.some(({ track }) => track.id === explorer.id)).toBe(
                expected,
            );
        },
    );

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

    it("softly rotates a recently exposed artist using the persisted normalized key", () => {
        const repeatedArtist = candidate(
            "another-track",
            "  Repeat   ARTIST ",
            {
                providerPrior: 1.2,
            },
        );
        const freshArtist = candidate("fresh-track", "Fresh Artist", {
            providerPrior: 1.1,
        });

        const ranked = rankRecommendationCandidates(
            [repeatedArtist, freshArtist],
            {
                now,
                limit: 2,
                sessionId: "session-artist-recency",
                direction: "for-you",
                mood: null,
                dislikedCanonicalKeys: new Set(),
                exposures: [
                    {
                        canonicalKey: "mbid:previous-track",
                        artistKey: "repeat artist",
                        exposedAt: new Date("2026-09-01T11:55:00.000Z"),
                    },
                ],
                positiveCentroids: [],
                negativeCentroids: [],
            },
        );

        expect(ranked.map((item) => item.track.id)).toEqual([
            "yt:fresh-track",
            "yt:another-track",
        ]);
    });

    it("bounds artist recency by the newest exposure instead of accumulating rows", () => {
        const repeatedArtist = candidate("another-track", "Repeat Artist", {
            providerPrior: 1.2,
        });
        const freshArtist = candidate("fresh-track", "Fresh Artist", {
            providerPrior: 1.1,
        });
        const newestExposure: RecommendationExposureSignal = {
            canonicalKey: "mbid:previous-track",
            artistKey: "repeat artist",
            exposedAt: new Date("2026-09-01T11:55:00.000Z"),
        };
        const options = {
            now,
            limit: 2,
            sessionId: "session-bounded-artist-recency",
            direction: "for-you" as const,
            mood: null,
            dislikedCanonicalKeys: new Set<string>(),
            positiveCentroids: [] as number[][],
            negativeCentroids: [] as number[][],
        };

        const once = rankRecommendationCandidates(
            [repeatedArtist, freshArtist],
            { ...options, exposures: [newestExposure] },
        );
        const repeated = rankRecommendationCandidates(
            [repeatedArtist, freshArtist],
            {
                ...options,
                exposures: [
                    newestExposure,
                    { ...newestExposure },
                    {
                        ...newestExposure,
                        canonicalKey: "mbid:older-track",
                        exposedAt: new Date("2026-09-01T08:00:00.000Z"),
                    },
                ],
            },
        );

        expect(repeated).toEqual(once);
        expect(
            repeated.some((item) => item.track.id === "yt:another-track"),
        ).toBe(true);
    });

    it("decays the artist penalty to zero over one day", () => {
        const repeatedArtist = candidate("another-track", "Repeat Artist");
        const scoreAtAge = (ageMs: number) =>
            rankRecommendationCandidates([repeatedArtist], {
                now,
                limit: 1,
                sessionId: "session-decaying-artist-recency",
                direction: "for-you",
                mood: null,
                dislikedCanonicalKeys: new Set(),
                exposures: [
                    {
                        canonicalKey: "mbid:previous-track",
                        artistKey: "repeat artist",
                        exposedAt: new Date(now.getTime() - ageMs),
                    },
                ],
                positiveCentroids: [],
                negativeCentroids: [],
            })[0].score;

        const recent = scoreAtAge(0);
        const halfDay = scoreAtAge(12 * 60 * 60 * 1_000);
        const expired = scoreAtAge(24 * 60 * 60 * 1_000);

        expect(recent).toBeLessThan(halfDay);
        expect(halfDay).toBeLessThan(expired);
        expect(expired - recent).toBeCloseTo(0.6, 6);
    });

    it("uses the persisted artist-key normalization for in-generation caps", () => {
        const ranked = rankRecommendationCandidates(
            [
                candidate("variant-a", "Repeat Artist", { providerPrior: 3 }),
                candidate("variant-b", "  repeat   ARTIST ", {
                    providerPrior: 2.9,
                }),
                candidate("variant-c", "repeat artist", {
                    providerPrior: 2.8,
                }),
                candidate("fresh-a", "Fresh A", { providerPrior: 2.7 }),
                candidate("fresh-b", "Fresh B", { providerPrior: 2.6 }),
            ],
            {
                now,
                limit: 5,
                sessionId: "session-normalized-artist-cap",
                direction: "for-you",
                mood: null,
                dislikedCanonicalKeys: new Set(),
                exposures: [],
                positiveCentroids: [],
                negativeCentroids: [],
            },
        );

        expect(
            ranked.filter((item) =>
                item.track.artist.name.toLocaleLowerCase().includes("repeat"),
            ),
        ).toHaveLength(2);
    });

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

    it.each([
        ["liked without analysis", 0.75, undefined, 0.6],
        ["liked with analysis", 0.75, { energy: 0.9, valence: 0.8 }, 0.6],
        ["unliked without analysis", 0, undefined, 0],
        ["unliked with analysis", 0, { energy: 0.9, valence: 0.8 }, 0],
    ] as const)(
        "applies favorites affinity for %s",
        (_label, accountAffinity, audioFeatures, expectedBoost) => {
            const item = candidate("favorites-candidate", "artist-favorite", {
                accountAffinity,
                audioFeatures,
            });
            const scoreForMood = (mood: "favorites" | null) =>
                rankRecommendationCandidates([item], {
                    now,
                    limit: 1,
                    sessionId: "session-favorites-affinity",
                    direction: "for-you",
                    mood,
                    dislikedCanonicalKeys: new Set(),
                    exposures: [],
                    positiveCentroids: [],
                    negativeCentroids: [],
                })[0].score;

            expect(scoreForMood("favorites") - scoreForMood(null)).toBeCloseTo(
                expectedBoost,
                6,
            );
        },
    );

    it("keeps feature-dependent moods neutral without audio analysis", () => {
        const item = candidate("unanalyzed", "artist-unanalyzed", {
            accountAffinity: 0.75,
        });
        const scoreForMood = (mood: "energetic" | null) =>
            rankRecommendationCandidates([item], {
                now,
                limit: 1,
                sessionId: "session-unanalyzed-mood",
                direction: "for-you",
                mood,
                dislikedCanonicalKeys: new Set(),
                exposures: [],
                positiveCentroids: [],
                negativeCentroids: [],
            })[0].score;

        expect(scoreForMood("energetic")).toBeCloseTo(scoreForMood(null), 6);
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
