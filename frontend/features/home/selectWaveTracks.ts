import type {
    PersonalizedHomeFeed,
    PersonalizedHomeMode,
    PersonalizedTrack,
} from "./types";

function unique(tracks: readonly PersonalizedTrack[]): PersonalizedTrack[] {
    const seen = new Set<string>();
    return tracks.filter((track) => {
        const key = track.youtubeVideoId || track.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** The same Wave lane policy for Home quick start and the dedicated Wave page. */
export function selectWaveTracks(
    shelves: PersonalizedHomeFeed["shelves"] | undefined,
    mode: PersonalizedHomeMode,
): PersonalizedTrack[] {
    if (!shelves) return [];
    if (mode === "new") return unique(shelves.discovery);
    if (mode === "familiar")
        return unique(
            shelves.listenAgain.length > 0
                ? shelves.listenAgain
                : shelves.quickPicks,
        );
    const interleaved: PersonalizedTrack[] = [];
    for (
        let i = 0;
        i < Math.max(shelves.quickPicks.length, shelves.discovery.length);
        i += 1
    ) {
        if (shelves.quickPicks[i]) interleaved.push(shelves.quickPicks[i]);
        if (shelves.discovery[i]) interleaved.push(shelves.discovery[i]);
    }
    const fresh = unique(interleaved);
    if (fresh.length === 0) return unique(shelves.listenAgain);
    const ids = new Set(fresh.map((track) => track.youtubeVideoId || track.id));
    const recent = unique(shelves.listenAgain).filter(
        (track) => !ids.has(track.youtubeVideoId || track.id),
    );
    const result: PersonalizedTrack[] = [];
    let recentIndex = 0;
    fresh.forEach((track, i) => {
        result.push(track);
        if ((i + 1) % 5 === 0 && recentIndex < recent.length)
            result.push(recent[recentIndex++]);
    });
    return result;
}
