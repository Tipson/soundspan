export type PrimarySongsSurface =
    | "playable"
    | "soulseek"
    | "soulseek-loading"
    | "empty";

interface PrimarySongsSurfaceInput {
    playableTrackCount: number;
    soulseekResultCount: number;
    soulseekSearching: boolean;
    showSoulseek: boolean;
}

interface SearchLoadingStateInput {
    hasSearched: boolean;
    anySourceSearching: boolean;
    hasArtistResult: boolean;
    discoverResultCount: number;
    primarySongsSurface: PrimarySongsSurface;
}

interface VisibleTrackResultsInput {
    libraryTrackCount: number;
    discoverTrackCount: number;
    soulseekResultCount: number;
    showLibrary: boolean;
    showDiscover: boolean;
    showSoulseek: boolean;
}

/** Count only sources that the active search filter can actually render. */
export function hasVisibleTrackResults({
    libraryTrackCount,
    discoverTrackCount,
    soulseekResultCount,
    showLibrary,
    showDiscover,
    showSoulseek,
}: VisibleTrackResultsInput): boolean {
    return (
        (showLibrary && libraryTrackCount > 0) ||
        (showDiscover && discoverTrackCount > 0) ||
        (showSoulseek && soulseekResultCount > 0)
    );
}

/**
 * Keeps instant playable catalog results ahead of slower acquisition sources.
 * A background Soulseek lookup must never hide tracks the user can play now.
 */
export function resolvePrimarySongsSurface({
    playableTrackCount,
    soulseekResultCount,
    soulseekSearching,
    showSoulseek,
}: PrimarySongsSurfaceInput): PrimarySongsSurface {
    if (playableTrackCount > 0) return "playable";
    if (!showSoulseek) return "empty";
    if (soulseekResultCount > 0) return "soulseek";
    if (soulseekSearching) return "soulseek-loading";
    return "empty";
}

/** Keep slow-source progress from covering results that can already play. */
export function shouldShowSearchLoadingState({
    hasSearched,
    anySourceSearching,
    hasArtistResult,
    discoverResultCount,
    primarySongsSurface,
}: SearchLoadingStateInput): boolean {
    return (
        hasSearched &&
        anySourceSearching &&
        !hasArtistResult &&
        discoverResultCount === 0 &&
        primarySongsSurface !== "playable"
    );
}
