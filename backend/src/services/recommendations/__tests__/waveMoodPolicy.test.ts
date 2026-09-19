import { matchesWaveMood } from "../wavePolicy";
import type { RecommendationCandidate } from "../types";
describe("Wave mood eligibility", () => {
    const track = (arousal: number | null | undefined) =>
        ({
            audioFeatures: { arousal, energy: 0.1 },
        }) as RecommendationCandidate;
    it("keeps boundary values and rejects unknown, nonfinite and out-of-range measurements", () => {
        expect(matchesWaveMood(track(0.45), "calm")).toBe(true);
        expect(matchesWaveMood(track(0.451), "calm")).toBe(false);
        expect(matchesWaveMood(track(0.55), "energetic")).toBe(true);
        expect(matchesWaveMood(track(0.549), "energetic")).toBe(false);
        for (const value of [null, undefined, NaN, Infinity, -0.1, 1.1])
            for (const mood of ["calm", "energetic"] as const)
                expect(matchesWaveMood(track(value), mood)).toBe(false);
    });
    it("does not restrict neutral or legacy collection contexts", () => {
        for (const mood of [null, undefined, "favorites", "forgotten"] as const)
            expect(matchesWaveMood(track(null), mood)).toBe(true);
    });
});
