import type { DiscoverResult, LibraryTrack } from "./types";

/**
 * Normalize an artist/title pair for owned-vs-external song comparison:
 * lowercase while preserving recording qualifiers, then drop punctuation
 * and spacing so "T.N.T.", "TNT",
 * and "AC/DC" vs "AC DC" all compare equal.
 */
export function normalizeSongKey(artist: string, title: string): string {
    const normalizePart = (value: string): string =>
        value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    return `${normalizePart(artist)}::${normalizePart(title)}`;
}

/**
 * Drop external track results that duplicate a song already present in the
 * library results with matching recording duration. Missing evidence and
 * selectable service versions remain visible instead of hiding alternatives.
 */
export function dedupeDiscoverTracks(
    discoverTracks: DiscoverResult[],
    libraryTracks: LibraryTrack[],
): DiscoverResult[] {
    if (discoverTracks.length === 0 || libraryTracks.length === 0) {
        return discoverTracks;
    }
    const ownedKeys = new Map<string, number[]>();
    for (const track of libraryTracks) {
        if (!Number.isFinite(track.duration) || track.duration <= 0) continue;
        const key = normalizeSongKey(track.album.artist.name, track.title);
        ownedKeys.set(key, [...(ownedKeys.get(key) ?? []), track.duration]);
    }
    return discoverTracks.filter(
        (track) =>
            !track.artist ||
            track.musicSourceRecording ||
            track.versions?.length ||
            !track.duration ||
            track.duration <= 0 ||
            !(
                ownedKeys.get(normalizeSongKey(track.artist, track.name)) ?? []
            ).some((duration) => Math.abs(duration - track.duration!) <= 2),
    );
}
