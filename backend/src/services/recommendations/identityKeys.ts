const MAX_CACHED_IDENTITY_INPUTS = 4_096;
const MAX_CACHED_IDENTITY_LENGTH = 512;
// Bound both key and result to at most 8 MiB of UTF-16 payload in total.
const normalizedIdentityInputs = new Map<string, string>();

/** Shared normalization for persisted and candidate artist identities. */
export function normalizeRecommendationArtistKey(value: string): string {
    const cacheable =
        typeof value === "string" && value.length <= MAX_CACHED_IDENTITY_LENGTH;
    const cached = cacheable ? normalizedIdentityInputs.get(value) : undefined;
    if (cached !== undefined) {
        normalizedIdentityInputs.delete(value);
        normalizedIdentityInputs.set(value, cached);
        return cached;
    }
    const normalized = value
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLocaleLowerCase("en-US");
    if (cacheable && normalized.length <= MAX_CACHED_IDENTITY_LENGTH) {
        if (normalizedIdentityInputs.size >= MAX_CACHED_IDENTITY_INPUTS) {
            // Amortize oldest-entry scans when inputs continuously change.
            let remaining = MAX_CACHED_IDENTITY_INPUTS / 4;
            for (const key of normalizedIdentityInputs.keys()) {
                normalizedIdentityInputs.delete(key);
                remaining -= 1;
                if (remaining === 0) break;
            }
        }
        normalizedIdentityInputs.set(value, normalized);
    }
    return normalized;
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
