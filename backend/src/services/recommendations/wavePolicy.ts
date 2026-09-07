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
