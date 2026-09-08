import { moodFeatureScore, rankRecommendationCandidates } from "../rankerV2";
import type { RecommendationCandidate } from "../types";

// Same mastered loudness, different measured perceptual intensity.
const track = (arousal: number | null): RecommendationCandidate => ({
    id: "yt:example",
    canonicalKey: "example",
    title: "Example",
    duration: 180,
    artist: { id: null, name: "Artist" },
    album: { id: null, title: "Album", coverArt: null },
    source: "youtube",
    streamSource: "youtube",
    provider: { youtubeVideoId: "example", tidalTrackId: null },
    candidateSources: ["youtube-radio"],
    providerPrior: 1,
    audioFeatures: {
        energy: 1,
        danceability: 0.5,
        instrumentalness: 0.2,
        arousal,
    },
});

test("equally loud songs separate by perceptual intensity, not mastering volume", () => {
    expect(moodFeatureScore(track(0.1), "calm")).toBeGreaterThan(
        moodFeatureScore(track(0.9), "calm") + 0.4,
    );
    expect(moodFeatureScore(track(0.9), "energetic")).toBeGreaterThan(
        moodFeatureScore(track(0.1), "energetic") + 0.4,
    );
    expect(moodFeatureScore(track(0.9), "workout")).toBeGreaterThan(
        moodFeatureScore(track(0.1), "workout") + 0.3,
    );
});

test("zero intensity is a valid calm measurement and missing intensity uses energy", () => {
    expect(moodFeatureScore(track(0), "calm")).toBeCloseTo(0.76);
    expect(moodFeatureScore(track(null), "energetic")).toBeCloseTo(0.85);
    expect(moodFeatureScore(track(null), null)).toBe(0);
});

test("pending analysis with all-null features is not treated as a measured mood match", () => {
    const pending = {
        ...track(null),
        audioFeatures: {
            energy: null,
            arousal: null,
            danceability: null,
            instrumentalness: null,
        },
    };
    for (const mood of ["calm", "energetic", "focus", "workout"] as const) {
        expect(moodFeatureScore(pending, mood)).toBe(0);
    }
});

test("explicit calm mood outweighs a modest taste advantage without losing the personal pool", () => {
    const calm = { ...track(0.1), id: "calm", canonicalKey: "calm" };
    const intense = {
        ...track(0.9),
        id: "intense",
        canonicalKey: "intense",
        accountAffinity: 0.8,
    };
    const options = {
        now: new Date("2026-09-08T12:00:00Z"),
        limit: 1,
        sessionId: "mood-test",
        direction: "familiar" as const,
        dislikedCanonicalKeys: new Set<string>(),
        exposures: [],
        positiveCentroids: [],
        negativeCentroids: [],
    };
    expect(
        rankRecommendationCandidates([intense, calm], {
            ...options,
            mood: "calm",
        })[0].track.id,
    ).toBe("calm");
    expect(
        rankRecommendationCandidates([intense, calm], {
            ...options,
            mood: null,
        })[0].track.id,
    ).toBe("intense");
});
