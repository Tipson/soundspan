/**
 * Pure decision math for the overlay Related tab's stream matching
 * (GH #787): row identity, relevance ordering, and YouTube stream matching.
 * Kept free of React and network code so
 * the matching rules are unit-testable.
 */

export interface RelatedTrackLike {
    id?: string;
    title: string;
    artist?: string | { id?: string; name?: string; mbid?: string };
    similarity?: number;
    inLibrary?: boolean;
    matchConfidence?: number;
    duration?: number;
    streamSource?: "youtube";
    youtubeVideoId?: string;
    album?: {
        title?: string;
        artist?: { name?: string };
    };
}

export interface RelatedStreamMatch {
    streamSource: "youtube";
    youtubeVideoId?: string;
    title?: string;
    artist?: string;
    duration?: number;
}

export interface StreamMatchQuery {
    artist: string;
    title: string;
    albumTitle?: string;
    duration?: number;
}

/** Read both the released string contract and the legacy object response. */
export function getRelatedTrackArtistName(track: RelatedTrackLike): string {
    if (typeof track.artist === "string") return track.artist;
    return track.artist?.name || track.album?.artist?.name || "";
}

/** Stable identity for a related row: library id, else artist+title. */
export function getRelatedTrackKey(track: RelatedTrackLike): string {
    if (track.id) return `lib:${track.id}`;
    const normalizedArtist = (getRelatedTrackArtistName(track) || "unknown")
        .trim()
        .toLowerCase();
    const normalizedTitle = (track.title || "unknown").trim().toLowerCase();
    return `ext:${normalizedArtist}::${normalizedTitle}`;
}

function scoreRelatedTrack(track: RelatedTrackLike): number {
    const confidence =
        typeof track.matchConfidence === "number" &&
        Number.isFinite(track.matchConfidence)
            ? track.matchConfidence
            : 0;
    const similarity =
        typeof track.similarity === "number" &&
        Number.isFinite(track.similarity)
            ? track.similarity * 100
            : 0;
    return (track.inLibrary ? 1000 : 0) + confidence * 2 + similarity;
}

/** Library rows first, then by match confidence and similarity. */
export function sortRelatedTracksByRelevance<T extends RelatedTrackLike>(
    tracks: readonly T[],
): T[] {
    if (tracks.length === 0) return [];
    return [...tracks].sort(
        (a, b) => scoreRelatedTrack(b) - scoreRelatedTrack(a),
    );
}

/** Rows still needing a stream match: external, identified, and unmatched. */
export function selectTracksNeedingStreamMatch<T extends RelatedTrackLike>(
    tracks: readonly T[],
    existingMatches: Readonly<Record<string, RelatedStreamMatch>>,
): T[] {
    return tracks.filter((track) => {
        if (track.inLibrary) return false;
        if (track.streamSource === "youtube" && track.youtubeVideoId) {
            return false;
        }
        const hasArtist = Boolean(getRelatedTrackArtistName(track).trim());
        if (!track.title || !hasArtist) return false;
        return !existingMatches[getRelatedTrackKey(track)];
    });
}

/** The lookup payload a batch-match request sends for each row. */
export function buildStreamMatchQuery(
    track: RelatedTrackLike,
): StreamMatchQuery {
    return {
        artist: getRelatedTrackArtistName(track),
        title: track.title,
        albumTitle: track.album?.title,
        duration: track.duration,
    };
}
