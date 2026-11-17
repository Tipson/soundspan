import {
    buildRecommendationGenerationTrace as build,
    readRecommendationGenerationTrace as read,
} from "../generationTrace";
import type { ScoredRecommendation } from "../types";
import type { RankScorePartNameV1 } from "../scoreTrace";

const names: RankScorePartNameV1[] = [
    "providerPrior",
    "accountAffinity",
    "moodFeatures",
    "positiveSimilarity",
    "negativeFeedback",
    "moodSimilarity",
    "sessionPositive",
    "contextSimilarity",
    "recentRecording",
    "recentArtist",
    "recentAlbum",
    "exploration",
];
function row(id: number): ScoredRecommendation {
    return {
        track: {
            id: `private-${id}`,
            canonicalKey: `private-key-${id}`,
            title: "private title",
            artist: { id: null, name: `Artist ${id}` },
            album: {
                id: null,
                title: "private album",
                coverArt: "https://private.invalid/token",
            },
            duration: 180,
            source: "youtube",
            streamSource: "youtube",
            provider: { youtubeVideoId: `video-${id}`, tidalTrackId: null },
            candidateSources: ["private source"],
            providerPrior: 1,
        },
        score: 1,
        scoreTrace: {
            version: 1,
            policy: "hybrid-v2",
            baseScore: 1,
            parts: names.map((name) => ({
                name,
                state: "known",
                value: 0.08333333333333333,
            })),
            selection: {
                method: "mmr",
                score: 0.9,
                diversityPenalty: 0.1,
                cooldown: "fresh",
            },
        },
    };
}
function input(rows: ScoredRecommendation[]) {
    return {
        algorithm: "hybrid-v2" as const,
        mode: "active" as const,
        served: true,
        requestedCount: rows.length,
        ranked: rows,
        finalized: rows,
        spacingApplied: false,
        coverage: {
            loadedCount: rows.length,
            sanitizedCount: rows.length,
            canonicalIdPresentCount: 0,
            embeddingPresentCount: 0,
            admittedCount: rows.length,
            rankInputCount: rows.length,
            loadedSources: {
                youtube: rows.length,
                library: 0,
                tidal: 0,
                vk: 0,
                yandex: 0,
            },
        },
        filters: {
            invalidNative: 0,
            contentExcluded: 0,
            moodExcluded: 0,
            disliked: 0,
            feedbackUnavailable: 0,
        },
    };
}

describe("bounded recommendation generation trace", () => {
    it("retains exact global and occurrence positions without private candidate metadata", () => {
        const a = row(1),
            b = row(2),
            ranked = [a, a, b];
        const trace = build({
            ...input(ranked),
            finalized: [b, a, a],
            startPosition: 41,
        });
        expect(
            trace?.items.map((item) => [item.position, item.rankPosition]),
        ).toEqual([
            [41, 2],
            [42, 0],
            [43, 1],
        ]);
        expect(JSON.stringify(trace)).not.toMatch(/private|https:|embedding":/);
        expect(ranked).toEqual([a, a, b]);
    });
    it("keeps a usable contiguous prefix when 75 full numerical traces exceed the byte budget", () => {
        const rows = Array.from({ length: 75 }, (_, i) => row(i));
        const trace = build(input(rows));
        expect(trace).toBeDefined();
        expect(trace!.items.length).toBeGreaterThan(0);
        expect(trace!.items.length).toBeLessThan(75);
        expect(trace!.truncated).toBe(true);
        expect(trace!.spacing).toMatchObject({
            observedRows: 75,
            scope: "page",
        });
        expect(Buffer.byteLength(JSON.stringify(trace))).toBeLessThanOrEqual(
            65_536,
        );
        expect(trace!.items.map((item) => item.position)).toEqual(
            trace!.items.map((_, i) => i),
        );
    });
    it("rejects an unknown version before invoking input serialization", () => {
        const toJSON = jest.fn(() => ({ version: 2 }));
        expect(read({ version: 2, toJSON })).toBeUndefined();
        expect(toJSON).not.toHaveBeenCalled();
    });
    it("rejects malformed stored positions, scoring policy and invented unknown contributions", () => {
        const trace = build(input([row(1), row(2)]))!;
        expect(read({ ...trace, privateHistory: ["secret"] })).toBeUndefined();
        const duplicate = structuredClone(trace);
        duplicate.items[1].position = duplicate.items[0].position;
        expect(read(duplicate)).toBeUndefined();
        const unknown = structuredClone(trace);
        unknown.items[0].scoring!.parts[0] = {
            name: "providerPrior",
            state: "absent",
            value: 0,
        };
        expect(read(unknown)).toBeUndefined();
        const wrongPolicy = structuredClone(trace);
        wrongPolicy.items[0].scoring!.policy = "baseline-v1";
        expect(read(wrongPolicy)).toBeUndefined();
        expect(read(undefined)).toBeUndefined();
    });
    it("does not let an optional diagnostic getter fail serving or rewrite an actual score", () => {
        const normal = row(1);
        normal.score = 2_000_001;
        normal.scoreTrace = { ...normal.scoreTrace!, baseScore: normal.score };
        expect(build(input([normal]))?.items[0].score).toBe(2_000_001);
        const broken = row(2);
        Object.defineProperty(broken, "scoreTrace", {
            get: () => {
                throw new Error("diagnostic unavailable");
            },
        });
        expect(() => build(input([broken]))).not.toThrow();
        expect(build(input([broken]))).toBeUndefined();
    });
});
