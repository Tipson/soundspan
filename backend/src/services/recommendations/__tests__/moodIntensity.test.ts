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

test("focus does not prefer aggressive instrumental music over a gentle vocal song", () => {
    const gentle = track(0.2);
    gentle.audioFeatures!.instrumentalness = 0.1;
    gentle.audioFeatures!.danceability = 0.2;
    const aggressive = track(0.95);
    aggressive.audioFeatures!.instrumentalness = 0.95;
    aggressive.audioFeatures!.danceability = 0.6;
    expect(moodFeatureScore(gentle, "focus")).toBeGreaterThan(
        moodFeatureScore(aggressive, "focus"),
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

test("a small personal pool separates the opening songs even when the whole-queue means match", () => {
    const pool = Array.from({ length: 12 }, (_, i) => ({
        ...track((i + 1) / 13),
        id: `yt:small-${i}`,
        canonicalKey: `small-${i}`,
        artist: { id: null, name: `Personal artist ${i}` },
        provider: { tidalTrackId: null, youtubeVideoId: `small-${i}` },
    }));
    const options = {
        now: new Date("2026-09-10T12:00:00Z"),
        limit: 12,
        sessionId: "small-personal-pool",
        direction: "for-you" as const,
        dislikedCanonicalKeys: new Set<string>(),
        exposures: [],
        positiveCentroids: [],
        negativeCentroids: [],
    };
    const calm = rankRecommendationCandidates(pool, {
        ...options,
        mood: "calm",
    });
    const energetic = rankRecommendationCandidates(pool, {
        ...options,
        mood: "energetic",
    });
    const intensity = (items: typeof calm) =>
        items.reduce(
            (sum, item) => sum + item.track.audioFeatures!.arousal!,
            0,
        ) / items.length;
    expect(calm).toHaveLength(12);
    expect(energetic).toHaveLength(12);
    expect(intensity(calm)).toBeCloseTo(intensity(energetic));
    expect(
        intensity(energetic.slice(0, 6)) - intensity(calm.slice(0, 6)),
    ).toBeGreaterThan(0.4);
    expect(new Set(calm.map((item) => item.track.id))).toEqual(
        new Set(pool.map((item) => item.id)),
    );
});
