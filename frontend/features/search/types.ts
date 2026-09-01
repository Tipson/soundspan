import type {
    FederatedTrackPeer,
    UnifiedTrackSource,
} from "@soundspan/media-metadata-contract";

export type SearchResultView = "all" | "tracks" | "artists" | "albums";

export interface Artist {
    id: string;
    name: string;
    heroUrl?: string;
    mbid?: string;
    image?: string;
    source?: UnifiedTrackSource;
    peer?: FederatedTrackPeer;
}

export interface Album {
    id: string;
    rgMbid?: string;
    title: string;
    coverUrl?: string;
    albumId?: string;
    artist?: {
        name: string;
    };
    source?: UnifiedTrackSource;
    peer?: FederatedTrackPeer;
}

export interface Podcast {
    id: string;
    title: string;
    author?: string;
    imageUrl?: string;
    episodeCount?: number;
}

export interface Episode {
    id: string;
    title: string;
    description?: string | null;
    podcastId: string;
    podcastTitle: string;
    publishedAt: Date | string;
    duration: number;
    audioUrl: string;
}

export interface Audiobook {
    id: string;
    title: string;
    author?: string | null;
    narrator?: string | null;
    series?: string | null;
    description?: string | null;
    coverUrl?: string | null;
    duration?: number | null;
}

export interface LibraryTrack {
    loudnessLufs?: number | null;
    truePeakDb?: number | null;
    id: string;
    title: string;
    duration: number;
    album: {
        albumLoudnessLufs?: number | null;
        albumTruePeakDb?: number | null;
        id: string;
        title: string;
        coverUrl?: string | null;
        artist: {
            id: string;
            mbid?: string;
            name: string;
        };
    };
    // Metadata override fields
    displayTitle?: string | null;
    displayTrackNo?: number | null;
    hasUserOverrides?: boolean;
    source?: UnifiedTrackSource;
    peer?: FederatedTrackPeer;
}

export interface SearchResult {
    artists?: Artist[];
    albums?: Album[];
    podcasts?: Podcast[];
    tracks?: LibraryTrack[];
    audiobooks?: Audiobook[];
    episodes?: Episode[];
}

export interface DiscoverResult {
    type: "music" | "album" | "podcast" | "track";
    id?: string;
    name: string;
    mbid?: string;
    image?: string;
    artist?: string;
    album?: string | null;
    coverUrl?: string;
    description?: string;
    feedUrl?: string;
    genres?: string[];
    trackCount?: number;
    listeners?: number;
    /** Exact remote-provider identity when the catalog result is playable. */
    providerTrackId?: string;
    streamSource?: "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    duration?: number | null;
    browseId?: string;
    year?: string | null;
    provider?: "ytmusic";
    releaseType?: string | null;
    /** YouTube Music artist route identity; accepted by discovery fallback. */
    youtubeChannelId?: string;
}

export interface AliasInfo {
    original: string;
    canonical: string;
    mbid?: string;
}

export interface DiscoverResponse {
    results: DiscoverResult[];
    aliasInfo: AliasInfo | null;
    pageInfo?: {
        requestedLimit: number;
        canRequestMoreTracks: boolean;
    };
}

export interface SimilarArtistsResponse {
    similarArtists: DiscoverResult[];
}

export interface SoulseekResult {
    username: string;
    path: string;
    filename: string;
    size: number;
    bitrate: number;
    format: string;
    parsedArtist?: string;
    parsedAlbum?: string;
    parsedTitle?: string;
}
