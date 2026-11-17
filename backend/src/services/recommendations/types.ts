import type { RecommendationScoreTraceV1 } from "./scoreTrace";

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
    source: "youtube" | "tidal" | "library" | "vk" | "yandex";
    provider: {
        tidalTrackId: number | null;
        youtubeVideoId: string | null;
        source?: "vk" | "yandex";
        providerTrackId?: string;
    };
    streamSource: "youtube" | "tidal" | "library" | "vk" | "yandex";
    /** Sanitized native metadata; exact playback revalidates authorization independently. */
    musicSourceRecording?: import("../musicSources/types").MusicSourceTrack;
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
        /** Perceived intensity; unlike RMS energy, not just mastering volume. */
        arousal?: number | null;
        valence?: number | null;
        danceability?: number | null;
        instrumentalness?: number | null;
    };
    lane?: "listenAgain" | "quickPicks" | "discovery";
}

export interface RecommendationExposureSignal {
    canonicalKey: string;
    artistKey?: string;
    /** Known album snapshot from an actually viewed, served recommendation. */
    albumKey?: string | null;
    exposedAt: Date;
}

/** Coarse request context used for session-aware recommendation ranking. */
export interface RecommendationRequestContext {
    localHour?: number;
    timezoneOffsetMinutes?: number;
    deviceClass?: "mobile" | "tablet" | "desktop" | "tv";
}

export interface RecommendRequest {
    userId: string;
    /** Use same-period listening across surfaces for a time-of-day mix. */
    timeOfDay?: boolean;
    intent: {
        surface: RecommendationSurface;
        direction: RecommendationDirection;
        mood?: RecommendationMood | null;
        language?: import("./recordingLanguage").WaveLanguage;
    };
    sessionId: string;
    context?: RecommendationRequestContext;
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
    /** Bounded numerical diagnostics, present only when explicitly collected. */
    scoreTrace?: RecommendationScoreTraceV1;
}

export interface RecommendResult {
    tracks: RecommendationCandidate[];
    nextCursor: number;
    generationId: string;
    degradedSources: string[];
    /** Server-owned context persisted with the served order; absent for legacy clients. */
    orderedWave?: import("./waveSequence").WaveSequenceContextV1;
}
