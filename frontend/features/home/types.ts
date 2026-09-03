/**
 * Home Page Type Definitions
 *
 * Defines all the data structures used throughout the Home page feature
 */

/**
 * Artist entity from the library
 */
export interface Artist {
    id: string;
    mbid?: string;
    name: string;
    coverArt?: string;
    albumCount?: number;
}

/**
 * Item that appears in the "Continue Listening" / "Recently Listened" section
 * Can be an artist, podcast, or audiobook with optional progress tracking
 */
export interface ListenedItem {
    id: string;
    name: string;
    coverArt?: string;
    type: "artist" | "podcast" | "audiobook";
    progress?: number; // 0-100 percentage for podcasts/audiobooks
    author?: string; // For podcasts and audiobooks
}

/**
 * Podcast entity
 */
export interface Podcast {
    id: string;
    title: string;
    author?: string;
    coverUrl?: string;
    coverArt?: string;
    imageUrl?: string;
}

/**
 * Audiobook entity
 */
export interface Audiobook {
    id: string;
    title: string;
    author?: string;
    coverUrl?: string;
}

/**
 * Programmatic mix (Made For You mixes)
 */
export interface Mix {
    id: string;
    name: string;
    description: string;
    coverUrls: string[];
    trackCount: number;
}

/**
 * Popular artist with listener count from Last.fm
 */
export interface PopularArtist {
    id?: string;
    name: string;
    image?: string;
    listeners?: number;
    mbid?: string;
}

/** Direction policy for one account's personalized Wave. */
export type PersonalizedHomeMode = "for-you" | "new" | "familiar";

export type PersonalizedRecommendationSurface =
    | "home"
    | "wave"
    | "made-for-you";

/** Mood or listening context applied independently from Wave direction. */
export type PersonalizedHomeMood =
    | "calm"
    | "energetic"
    | "focus"
    | "workout"
    | "favorites"
    | "forgotten";

/** Provider-neutral track returned by the personalized home feed. */
export interface PersonalizedTrack {
    id: string;
    title: string;
    duration: number;
    trackNo: number | null;
    artist: { id: string | null; name: string };
    album: {
        id: string | null;
        title: string;
        coverArt: string | null;
    };
    source: "youtube" | "tidal" | "library";
    provider: {
        tidalTrackId: number | null;
        youtubeVideoId: string | null;
    };
    streamSource: "youtube" | "tidal" | "library";
    youtubeVideoId?: string;
    tidalTrackId?: number;
}

export interface PersonalizedHomeFeed {
    shelves: {
        listenAgain: PersonalizedTrack[];
        quickPicks: PersonalizedTrack[];
        discovery: PersonalizedTrack[];
    };
    degraded: boolean;
    reason:
        | "insufficient_signals"
        | "provider_partial_failure"
        | "provider_unavailable"
        | null;
    seedCount: number;
    nextCursor?: number;
    generationId?: string;
    degradedSources?: string[];
}
