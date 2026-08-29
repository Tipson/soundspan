interface ArtistRouteInput {
    id?: string | null;
    mbid?: string | null;
    name?: string | null;
}

interface DiscoveryArtistRouteInput extends ArtistRouteInput {
    youtubeChannelId?: string | null;
}

interface ArtistRouteOptions {
    preferLibraryId?: boolean;
    encodeNameFallback?: boolean;
}

const normalizeRouteValue = (value?: string | null): string | null => {
    if (!value) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

export const isUsableArtistMbid = (mbid?: string | null): mbid is string => {
    const normalized = normalizeRouteValue(mbid);
    return Boolean(normalized && !normalized.startsWith("temp-"));
};

export const getArtistRouteParam = (
    artist: ArtistRouteInput,
    options: ArtistRouteOptions = {},
): string | null => {
    const id = normalizeRouteValue(artist.id);
    const mbid = normalizeRouteValue(artist.mbid);
    const name = normalizeRouteValue(artist.name);
    const preferLibraryId = options.preferLibraryId ?? true;
    const encodeNameFallback = options.encodeNameFallback ?? true;

    if (preferLibraryId && id) {
        return id;
    }

    if (isUsableArtistMbid(mbid)) {
        return mbid;
    }

    if (id) {
        return id;
    }

    if (name) {
        return encodeNameFallback ? encodeURIComponent(name) : name;
    }

    return null;
};

export const getArtistHref = (
    artist: ArtistRouteInput,
    options?: ArtistRouteOptions,
): string | null => {
    const routeParam = getArtistRouteParam(artist, options);
    return routeParam ? `/artist/${routeParam}` : null;
};

/**
 * Resolve a catalog artist without confusing a YouTube channel ID for a
 * Soundspan/MusicBrainz artist ID. A real MBID remains the canonical route;
 * YouTube-only artists carry their exact provider identity in the query.
 */
export const getDiscoveryArtistHref = (
    artist: DiscoveryArtistRouteInput,
): string | null => {
    const mbid = normalizeRouteValue(artist.mbid);
    if (isUsableArtistMbid(mbid)) {
        return `/artist/${mbid}`;
    }

    const youtubeChannelId = normalizeRouteValue(artist.youtubeChannelId);
    if (youtubeChannelId) {
        const routeName = normalizeRouteValue(artist.name) ?? youtubeChannelId;
        return `/artist/${encodeURIComponent(routeName)}?provider=ytmusic&channelId=${encodeURIComponent(youtubeChannelId)}`;
    }

    return getArtistHref(artist, { preferLibraryId: false });
};
