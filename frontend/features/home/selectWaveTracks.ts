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
    const discovery = unique(shelves.discovery);
    if (discovery.length === 0) {
        const saved = unique(shelves.quickPicks);
        return saved.length > 0 ? saved : unique(shelves.listenAgain);
    }
    const discoveryIds = new Set(
        discovery.map((track) => track.youtubeVideoId || track.id),
    );
    const saved = unique(shelves.quickPicks).filter(
        (track) => !discoveryIds.has(track.youtubeVideoId || track.id),
    );
    const fresh: PersonalizedTrack[] = [];
    let savedIndex = 0;
    discovery.forEach((track, index) => {
        fresh.push(track);
        if ((index + 1) % 4 === 0 && savedIndex < saved.length) {
            fresh.push(saved[savedIndex++]);
        }
    });
    const ids = new Set(fresh.map((track) => track.youtubeVideoId || track.id));
    const recent = unique(shelves.listenAgain).filter(
        (track) => !ids.has(track.youtubeVideoId || track.id),
    );
    const result: PersonalizedTrack[] = [];
    let recentIndex = 0;
    fresh.forEach((track, i) => {
        result.push(track);
        if ((i + 1) % 15 === 0 && recentIndex < recent.length)
            result.push(recent[recentIndex++]);
    });
    return result;
}
