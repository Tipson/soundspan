/** Existing automatic-feed lookback for songs with at least 30 listened seconds. */
export const PERSONALIZED_LISTENING_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000;
const ATTEMPT_REPEAT_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Persisted YouTube playback evidence required by the automatic repeat policy. */
export interface PersonalizedRepeatObservation {
    track: { videoId: string; artist: string; title: string };
    playedAt: Date | null;
    listenedSeconds: number | null;
    outcome: string | null;
}

/** Fresh-first exclusions and the stricter, non-relaxable last-day subset. */
export interface PersonalizedRepeatExclusions {
    videoIds: Set<string>;
    songKeys: Set<string>;
    hardVideoIds: Set<string>;
    hardSongKeys: Set<string>;
}

/** Normalize artist/title to match alternate uploads without guessing unknown metadata. */
export function songRepeatKey(artist: string, title: string): string | null {
    const normalize = (value: string) =>
        value
            .normalize("NFKC")
            .toLocaleLowerCase("en-US")
            .replace(/[^\p{L}\p{N}]+/gu, " ")
            .trim()
            .replace(/\s+/g, " ");
    const artistKey = normalize(artist);
    const titleKey = normalize(title);
    if (
        !artistKey ||
        !titleKey ||
        artistKey === "unknown artist" ||
        titleKey === "unknown track"
    )
        return null;
    return JSON.stringify([artistKey, titleKey]);
}

/** Preserve the catalog's 24-hour attempts and seven-day listening policy; failures are neutral. */
export function buildPersonalizedRepeatExclusions(
    observations: readonly PersonalizedRepeatObservation[],
    now: Date,
): PersonalizedRepeatExclusions {
    const exclusions: PersonalizedRepeatExclusions = {
        videoIds: new Set(),
        songKeys: new Set(),
        hardVideoIds: new Set(),
        hardSongKeys: new Set(),
    };
    for (const observation of observations) {
        const age =
            observation.playedAt === null
                ? NaN
                : now.getTime() - observation.playedAt.getTime();
        const recentAttempt = age >= 0 && age < ATTEMPT_REPEAT_WINDOW_MS;
        const recentListen =
            age >= 0 &&
            age < PERSONALIZED_LISTENING_LOOKBACK_MS &&
            (observation.listenedSeconds ?? 0) >= 30;
        if (
            (!recentAttempt && !recentListen) ||
            observation.outcome === "failed"
        )
            continue;
        const videoId = observation.track.videoId
            .trim()
            .replace(/^yt:/, "")
            .trim();
        const songKey = songRepeatKey(
            observation.track.artist,
            observation.track.title,
        );
        if (videoId) exclusions.videoIds.add(videoId);
        if (songKey) exclusions.songKeys.add(songKey);
        if (recentAttempt) {
            if (videoId) exclusions.hardVideoIds.add(videoId);
            if (songKey) exclusions.hardSongKeys.add(songKey);
        }
    }
    return exclusions;
}
