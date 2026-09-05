/** Shared normalization for persisted and candidate artist identities. */
export function normalizeRecommendationArtistKey(value: string): string {
    return value
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLocaleLowerCase("en-US");
}

/**
 * Snapshot identity of a known release, scoped to its credited artist.
 * JSON tuple encoding prevents delimiter collisions. Provider fallback labels
 * are not releases; ignoring them also keeps legacy/absent metadata neutral.
 */
export function buildRecommendationAlbumKey(
    artist: string,
    album: string,
): string | null {
    const artistKey = normalizeRecommendationArtistKey(artist);
    const albumTitle = normalizeRecommendationArtistKey(album);
    if (
        !artistKey ||
        artistKey === "unknown" ||
        artistKey === "unknown artist" ||
        !albumTitle ||
        albumTitle === "single" ||
        albumTitle === "unknown" ||
        albumTitle === "unknown album"
    ) {
        return null;
    }
    return JSON.stringify([artistKey, albumTitle]);
}
