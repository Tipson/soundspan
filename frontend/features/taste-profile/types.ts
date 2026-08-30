/** A provider-backed seed used by personalization without creating a like. */
export interface TasteSeedTrack {
    id: string;
    videoId: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    thumbnailUrl: string;
    artistId: string | null;
    albumId: string | null;
}

/** The listener's explicit taste signals and resolved playable seeds. */
export interface TasteProfile {
    genres: string[];
    artists: string[];
    seedTracks: TasteSeedTrack[];
}

/** Account-scoped state returned by `/api/taste-profile`. */
export interface TasteProfileState {
    profile: TasteProfile | null;
    completedAt: string | null;
    skippedAt: string | null;
    needsOnboarding: boolean;
}

/** Editable labels selected by the listener. */
export interface TasteProfileSelection {
    genres: string[];
    artists: string[];
}

/** Whether a write completes onboarding or replaces a saved profile. */
export type TasteProfileWriteMode = "create" | "replace";

/** The only write payloads accepted by the taste-profile endpoint. */
export type TasteProfileWriteRequest = TasteProfileSelection | { skip: true };
