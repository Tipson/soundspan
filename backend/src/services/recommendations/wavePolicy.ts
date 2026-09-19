import type { RecommendationCandidate, RecommendationMood } from "./types";

/** Explicit moods require measured perceptual intensity in every returned lane.
 * RMS energy and missing analysis cannot establish a mood match. Legacy clients
 * retain focus/workout as the calm/energetic eligibility families.
 */
export function matchesWaveMood(
    candidate: RecommendationCandidate,
    mood: RecommendationMood | null | undefined,
): boolean {
    if (!["calm", "focus", "energetic", "workout"].includes(mood ?? ""))
        return true;
    const intensity = candidate.audioFeatures?.arousal;
    if (
        intensity == null ||
        !Number.isFinite(intensity) ||
        intensity < 0 ||
        intensity > 1
    )
        return false;
    return mood === "calm" || mood === "focus"
        ? intensity <= 0.45
        : intensity >= 0.55;
}

/** Automatic Wave recommendations are songs, not full albums or background mixes.
 * Manual playback and the user's saved collection are not restricted by this policy.
 */
export function isWaveMusicCandidate(track: {
    title: string;
    duration: number;
}): boolean {
    if (track.duration >= 30 * 60) return false;
    return !(
        track.duration > 10 * 60 &&
        /\b(?:full album|non[ -]?stop|mega[ -]?mix|compilation)\b|полный альбом|сборник/i.test(
            track.title,
        )
    );
}
