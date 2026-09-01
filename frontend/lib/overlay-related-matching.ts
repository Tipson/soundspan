/**
 * Pure decision math for the overlay Related tab's stream matching
 * (GH #787): row identity, relevance ordering, and the TIDAL-first /
 * YouTube-fallback batch partition. Kept free of React and network code so
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
    streamSource?: "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    album?: {
        title?: string;
        artist?: { name?: string };
    };
}

export interface RelatedStreamMatch {
    streamSource: "tidal" | "youtube";
    tidalTrackId?: number;
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

export interface TidalBatchMatch {
    id: number;
    title: string;
    artist: string;
    duration: number;
    isrc?: string;
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
        if (
            (track.streamSource === "youtube" && track.youtubeVideoId) ||
            (track.streamSource === "tidal" && track.tidalTrackId)
        ) {
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

export interface TidalBatchPartition {
    /** Matches found on TIDAL, keyed by related-row identity. */
    foundMatches: Record<string, RelatedStreamMatch>;
    /** Rows TIDAL missed, to retry against YouTube Music. */
    youtubePayload: StreamMatchQuery[];
    youtubeTrackKeys: string[];
}

/** Split a TIDAL batch response into matches and the YouTube retry set. */
export function partitionTidalBatchMatches(
    missingTracks: readonly RelatedTrackLike[],
    tidalMatches: ReadonlyArray<TidalBatchMatch | null | undefined>,
): TidalBatchPartition {
    const foundMatches: Record<string, RelatedStreamMatch> = {};
    const youtubePayload: StreamMatchQuery[] = [];
    const youtubeTrackKeys: string[] = [];

    missingTracks.forEach((track, index) => {
        const trackKey = getRelatedTrackKey(track);
        const tidalMatch = tidalMatches[index];
        if (tidalMatch?.id) {
            foundMatches[trackKey] = {
                streamSource: "tidal",
                tidalTrackId: tidalMatch.id,
                title: tidalMatch.title,
                artist: tidalMatch.artist,
                duration: tidalMatch.duration,
            };
            return;
        }
        youtubePayload.push(buildStreamMatchQuery(track));
        youtubeTrackKeys.push(trackKey);
    });

    return { foundMatches, youtubePayload, youtubeTrackKeys };
}
