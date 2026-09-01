export type RecommendationSurface =
    | "wave"
    | "home"
    | "made-for-you"
    | "similar-tracks";

export type RecommendationDirection = "for-you" | "new" | "familiar";

export type RecommendationMood =
    | "calm"
    | "energetic"
    | "focus"
    | "workout"
    | "favorites"
    | "forgotten";

export interface RecommendationCandidate {
    id: string;
    canonicalKey: string;
    canonicalRecordingId?: string | null;
    recordingMbid?: string | null;
    isrc?: string | null;
    fingerprint?: string | null;
    title: string;
    duration: number;
    trackNo?: number | null;
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
    candidateSources: string[];
    providerPrior: number;
    accountAffinity?: number;
    moodSimilarity?: number;
    embedding?: number[] | null;
    audioFeatures?: {
        bpm?: number | null;
        energy?: number | null;
        valence?: number | null;
        danceability?: number | null;
        instrumentalness?: number | null;
    };
    lane?: "listenAgain" | "quickPicks" | "discovery";
}

export interface RecommendationExposureSignal {
    canonicalKey: string;
    exposedAt: Date;
}

export interface RecommendRequest {
    userId: string;
    intent: {
        surface: RecommendationSurface;
        direction: RecommendationDirection;
        mood?: RecommendationMood | null;
    };
    sessionId: string;
    cursor?: number;
    limit: number;
    /** Optional uniform cap for candidates originating from one product lane. */
    perLaneLimit?: number;
    exclude?: string[];
    seed?: {
        id?: string;
        artist?: string;
        title?: string;
    };
}

export interface ScoredRecommendation {
    track: RecommendationCandidate;
    score: number;
}

export interface RecommendResult {
    tracks: RecommendationCandidate[];
    nextCursor: number;
    generationId: string;
    degradedSources: string[];
}
