import {
    rankRecommendationCandidates,
    rankRecommendationCandidatesWithTrace,
    type RankRecommendationOptions,
} from "../rankerV2";
import type { RecommendationCandidate } from "../types";
import { buildRecommendationAlbumKey } from "../identityKeys";

const now = new Date("2026-11-15T12:00:00.000Z");

function candidate(
    id: string,
    overrides: Partial<RecommendationCandidate> = {},
): RecommendationCandidate {
    return {
        id: `yt:${id}`,
        canonicalKey: `canonical:${id}`,
        title: id,
        duration: 180,
        artist: { id: null, name: `artist-${id}` },
        album: { id: null, title: `album-${id}`, coverArt: null },
        source: "youtube",
        provider: { tidalTrackId: null, youtubeVideoId: id },
        streamSource: "youtube",
        candidateSources: ["private-source"],
        providerPrior: 1,
        ...overrides,
    };
}

function options(
    overrides: Partial<RankRecommendationOptions> = {},
): RankRecommendationOptions {
    return {
        now,
        limit: 4,
        sessionId: "private-session",
        direction: "familiar",
        mood: null,
        dislikedCanonicalKeys: new Set(),
        exposures: [],
        positiveCentroids: [],
        negativeCentroids: [],
        ...overrides,
    };
}

describe("ranker scoring trace", () => {
    it("retains measured contributions when a valid comparison shares a profile with mismatched targets", () => {
        const targets = [[1], [1, 0]];
        const result = rankRecommendationCandidatesWithTrace(
            [candidate("mixed-targets", { embedding: [1, 0] })],
            options({
                positiveCentroids: targets,
                negativeCentroids: targets,
                contextCentroids: targets,
            }),
        );
        const row = result.recommendations[0];
        expect(row.score).toBeCloseTo(1 + 1.35 - 0.4 + 0.45, 12);
        expect(row.scoreTrace!.parts).toEqual(
            expect.arrayContaining([
                { name: "positiveSimilarity", state: "known", value: 1.35 },
                { name: "negativeFeedback", state: "known", value: -0.4 },
                { name: "contextSimilarity", state: "known", value: 0.45 },
            ]),
        );
        expect(
            row.scoreTrace!.parts.reduce(
                (sum, part) => sum + (part.value ?? 0),
                0,
            ),
        ).toBeCloseTo(row.score, 12);
    });

    it.each(["familiar", "for-you", "new"] as const)(
        "preserves exact results and caller inputs with lanes, cooldown and exploration: %s",
        (direction) => {
            const tracks = [
                ...Array.from({ length: 4 }, (_, index) =>
                    candidate(`known-${index}`, {
                        providerPrior: 10 - index,
                        accountAffinity: 0.8,
                        lane: index < 2 ? "quickPicks" : "listenAgain",
                        embedding: [1, index / 4],
                        audioFeatures: { energy: 0.3, instrumentalness: 0.4 },
                    }),
                ),
                candidate("recent", { lane: "listenAgain", embedding: [0, 1] }),
                candidate("explorer", {
                    providerPrior: 0.1,
                    accountAffinity: 0,
                    lane: "discovery",
                    embedding: [0, 1],
                }),
            ];
            const settings = options({
                direction,
                mood: "calm",
                perLaneLimit: 2,
                explorationRate: 0.25,
                positiveCentroids: [[1, 0]],
                negativeCentroids: [[0, 1]],
                moodEmbedding: [3, 4],
                sessionPositiveEmbedding: [1, 1],
                sessionNegativeEmbedding: [0, 1],
                contextCentroids: [[1, 0]],
                exposures: [
                    { canonicalKey: "canonical:recent", exposedAt: now },
                ],
            });
            const before = structuredClone({ tracks, settings });
            const legacy = rankRecommendationCandidates(tracks, settings);
            const traced = rankRecommendationCandidatesWithTrace(
                tracks,
                settings,
            );
            expect(
                traced.recommendations.map(({ scoreTrace, ...row }) => row),
            ).toEqual(legacy);
            expect(legacy.every((row) => !("scoreTrace" in row))).toBe(true);
            expect({ tracks, settings }).toEqual(before);
            expect(
                rankRecommendationCandidatesWithTrace(tracks, settings),
            ).toEqual(traced);
            expect(
                traced.recommendations.some(
                    ({ scoreTrace }) =>
                        scoreTrace?.selection.method === "exploration",
                ),
            ).toBe(true);
            for (const { score, scoreTrace } of traced.recommendations) {
                expect(scoreTrace?.version).toBe(1);
                expect(scoreTrace?.baseScore).toBe(score);
                expect(scoreTrace?.parts).toHaveLength(12);
                expect(
                    scoreTrace!.parts.reduce(
                        (sum, part) => sum + (part.value ?? 0),
                        0,
                    ),
                ).toBeCloseTo(score, 12);
            }
            expect(traced.summary.counters.explorationReplaced).toBe(1);
            expect(traced.summary.counters.recentCooldown).toBeGreaterThan(0);
        },
    );

    it("records the actual MMR objective separately from the base score", () => {
        const tracks = [
            candidate("first", {
                providerPrior: 2,
                artist: { id: null, name: "same" },
            }),
            candidate("second", { artist: { id: null, name: "same" } }),
        ];
        const { recommendations } = rankRecommendationCandidatesWithTrace(
            tracks,
            options({ limit: 2 }),
        );
        expect(recommendations.map(({ score }) => score)).toEqual([2, 1]);
        expect(recommendations[0].scoreTrace?.selection).toEqual({
            method: "mmr",
            score: 2,
            diversityPenalty: 0,
            cooldown: "fresh",
        });
        expect(recommendations[1].scoreTrace?.selection).toEqual({
            method: "mmr",
            score: 1 - 0.82 * 0.42,
            diversityPenalty: 0.82 * 0.42,
            cooldown: "fresh",
        });
    });

    it("keeps fresh selection traces while filling remaining lane capacity from recent tracks", () => {
        const tracks = [
            candidate("fresh", { lane: "quickPicks" }),
            candidate("recent", { lane: "listenAgain" }),
        ];
        const settings = options({
            limit: 2,
            perLaneLimit: 1,
            exposures: [
                {
                    canonicalKey: "canonical:recent",
                    artistKey: "artist-recent",
                    albumKey: buildRecommendationAlbumKey(
                        "artist-recent",
                        "album-recent",
                    ),
                    exposedAt: now,
                },
            ],
        });
        const result = rankRecommendationCandidatesWithTrace(tracks, settings);
        expect(
            result.recommendations.map(({ scoreTrace, ...row }) => row),
        ).toEqual(rankRecommendationCandidates(tracks, settings));
        expect(
            result.recommendations.map(
                ({ scoreTrace }) => scoreTrace?.selection.cooldown,
            ),
        ).toEqual(["fresh", "backfill"]);
        expect(result.summary.counters).toMatchObject({
            freshSelected: 1,
            backfillSelected: 1,
            recentCooldown: 1,
        });
        const trace = result.recommendations[1].scoreTrace!;
        expect(
            trace.parts
                .filter(({ name }) => name.startsWith("recent"))
                .every(({ state, value }) => state === "known" && value! < 0),
        ).toBe(true);
        expect(
            trace.parts.reduce((sum, part) => sum + (part.value ?? 0), 0),
        ).toBeCloseTo(trace.baseScore!, 12);
    });

    it("distinguishes missing and mismatched measurements from disabled terms and measured zero", () => {
        const settings = options({
            mood: "calm",
            limit: 3,
            positiveCentroids: [[0, 1]],
            negativeCentroids: [[0, 1]],
            moodEmbedding: [1, 0],
            sessionPositiveEmbedding: [1, 0],
            contextCentroids: [[0, 1]],
        });
        const tracks = [
            candidate("missing"),
            candidate("mismatched", { embedding: [1] }),
            candidate("zero", {
                providerPrior: 0,
                accountAffinity: 0,
                moodSimilarity: 0,
                embedding: [1, 0],
            }),
        ];
        const result = rankRecommendationCandidatesWithTrace(tracks, settings);
        const byId = (id: string) =>
            result.recommendations.find(({ track }) => track.id === `yt:${id}`)!
                .scoreTrace!.parts;
        for (const id of ["missing", "mismatched"]) {
            expect(byId(id)).toEqual(
                expect.arrayContaining([
                    { name: "moodFeatures", state: "absent", value: null },
                    {
                        name: "positiveSimilarity",
                        state: "absent",
                        value: null,
                    },
                    { name: "negativeFeedback", state: "absent", value: null },
                    { name: "moodSimilarity", state: "absent", value: null },
                    { name: "sessionPositive", state: "absent", value: null },
                    { name: "contextSimilarity", state: "absent", value: null },
                    { name: "exploration", state: "unused", value: null },
                ]),
            );
        }
        expect(byId("zero")).toEqual(
            expect.arrayContaining([
                { name: "providerPrior", state: "known", value: 0 },
                { name: "accountAffinity", state: "known", value: 0 },
                { name: "moodFeatures", state: "known", value: 0 },
                { name: "positiveSimilarity", state: "known", value: 0 },
                { name: "negativeFeedback", state: "known", value: -0 },
                { name: "contextSimilarity", state: "known", value: 0 },
            ]),
        );
    });

    it("leaves invalid optional features absent and keeps ignored optional feature failures harmless", () => {
        const invalid = candidate("invalid", {
            embedding: [NaN, 1],
            audioFeatures: { arousal: NaN },
        });
        const settings = options({
            mood: null,
            positiveCentroids: [[1, 0]],
            moodEmbedding: [NaN, 1],
        });
        Object.defineProperty(invalid, "audioFeatures", {
            get() {
                throw new Error("unused optional feature unavailable");
            },
        });
        const legacy = rankRecommendationCandidates([invalid], settings);
        const result = rankRecommendationCandidatesWithTrace(
            [invalid],
            settings,
        );
        expect(
            result.recommendations.map(({ scoreTrace, ...row }) => row),
        ).toEqual(legacy);
        expect(result.recommendations[0].scoreTrace!.parts).toEqual(
            expect.arrayContaining([
                { name: "positiveSimilarity", state: "absent", value: null },
                { name: "moodSimilarity", state: "absent", value: null },
            ]),
        );
    });

    it("counts guard evaluations and selections without leaking candidate or request data", () => {
        const tracks = [
            candidate("invalid-native", { source: "vk" }),
            candidate("disliked"),
            candidate("missing", {
                provider: { youtubeVideoId: null, tidalTrackId: null },
            }),
            candidate("duplicate-a", { canonicalKey: "duplicate" }),
            candidate("duplicate-b", { canonicalKey: "duplicate" }),
            ...Array.from({ length: 4 }, (_, index) =>
                candidate(`cap-${index}`, {
                    artist: { id: null, name: "same" },
                    lane: "quickPicks",
                }),
            ),
        ];
        const settings = options({
            limit: 8,
            dislikedCanonicalKeys: new Set(["canonical:disliked"]),
        });
        const result = rankRecommendationCandidatesWithTrace(tracks, settings);
        expect(result.summary).toMatchObject({
            version: 1,
            policy: "hybrid-v2",
            inputCount: tracks.length,
            counters: {
                input: tracks.length,
                invalidNative: 1,
                disliked: 1,
                missingIdentity: 1,
                duplicateCanonical: 1,
                freshSelected: 3,
            },
        });
        expect(result.summary.counters.artistCap).toBeGreaterThan(0);
        const lane = rankRecommendationCandidatesWithTrace(
            tracks.slice(-4),
            options({ perLaneLimit: 1 }),
        );
        expect(lane.summary.counters.laneCap).toBeGreaterThan(0);
        const json = JSON.stringify({
            summary: result.summary,
            traces: result.recommendations.map(({ scoreTrace }) => scoreTrace),
        });
        for (const forbidden of [
            "private-session",
            "private-source",
            "canonical:",
            "artist-",
            "yt:",
        ])
            expect(json).not.toContain(forbidden);
    });

    it("bounds counters, preserves large finite scores and reports nonfinite values as absent", () => {
        const huge = candidate("huge", { providerPrior: 2_000_000 });
        const finite = rankRecommendationCandidatesWithTrace([huge], options());
        expect(finite.recommendations[0].score).toBe(2_000_000);
        expect(finite.recommendations[0].scoreTrace?.baseScore).toBe(2_000_000);
        expect(finite.recommendations[0].scoreTrace?.parts[0]).toEqual({
            name: "providerPrior",
            state: "known",
            value: 2_000_000,
        });
        expect(finite.recommendations[0].scoreTrace?.selection.score).toBe(
            2_000_000,
        );
        expect(
            finite.recommendations[0].scoreTrace!.parts.reduce(
                (sum, part) => sum + (part.value ?? 0),
                0,
            ),
        ).toBe(finite.recommendations[0].score);
        const infinite = rankRecommendationCandidatesWithTrace(
            [candidate("infinite", { providerPrior: Infinity })],
            options(),
        );
        expect(infinite.recommendations[0].score).toBe(Infinity);
        expect(infinite.recommendations[0].scoreTrace?.baseScore).toBeNull();
        expect(
            infinite.recommendations[0].scoreTrace?.selection.score,
        ).toBeNull();
        expect(infinite.recommendations[0].scoreTrace?.parts[0]).toEqual({
            name: "providerPrior",
            state: "absent",
            value: null,
        });
        const summary = rankRecommendationCandidatesWithTrace(
            new Array<RecommendationCandidate>(1_000_001),
            options(),
        ).summary;
        expect(summary.inputCount).toBe(1_000_000);
        expect(summary.counters.input).toBe(1_000_000);
    });
});
