import assert from "node:assert/strict";
import test from "node:test";
import {
    allocateSearchResultLimits,
    hasVisibleTrackResults,
    resolveSearchCatalogPolicy,
    resolvePrimarySongsSurface,
    shouldShowSearchLoadingState,
} from "../../features/search/searchSongsPriority";

test("general music search excludes podcasts and expands the dedicated tracks view", () => {
    assert.deepEqual(
        resolveSearchCatalogPolicy({
            isTracksView: false,
        }),
        {
            discoverType: "music",
            discoverLimit: 20,
            libraryType: "all",
            libraryLimit: 20,
            trackDisplayLimit: 5,
            albumDisplayLimit: 6,
        },
    );
    assert.deepEqual(
        resolveSearchCatalogPolicy({
            isTracksView: true,
        }),
        {
            discoverType: "music",
            discoverLimit: 50,
            libraryType: "tracks",
            libraryLimit: 50,
            trackDisplayLimit: 50,
            albumDisplayLimit: 6,
        },
    );
});

test("dedicated album and artist views request the expanded provider catalog", () => {
    for (const view of ["albums", "artists"] as const) {
        const policy = resolveSearchCatalogPolicy({
            isTracksView: false,
            isAlbumsView: view === "albums",
            isArtistsView: view === "artists",
        });
        assert.equal(policy.discoverLimit, 50);
        assert.equal(policy.libraryLimit, 50);
        assert.equal(policy.libraryType, view);
    }
});

test("overview and dedicated views cap merged result shelves, not each source independently", () => {
    assert.deepEqual(
        allocateSearchResultLimits({ primaryCount: 3, totalLimit: 5 }),
        { primaryLimit: 3, secondaryLimit: 2 },
    );
    assert.deepEqual(
        allocateSearchResultLimits({ primaryCount: 42, totalLimit: 50 }),
        { primaryLimit: 42, secondaryLimit: 8 },
    );
    assert.deepEqual(
        allocateSearchResultLimits({ primaryCount: 80, totalLimit: 50 }),
        { primaryLimit: 50, secondaryLimit: 0 },
    );
});

test("hidden sources do not count as tracks for the active search filter", () => {
    assert.equal(
        hasVisibleTrackResults({
            libraryTrackCount: 4,
            discoverTrackCount: 0,
            soulseekResultCount: 3,
            showLibrary: false,
            showDiscover: true,
            showSoulseek: false,
        }),
        false,
    );
    assert.equal(
        hasVisibleTrackResults({
            libraryTrackCount: 4,
            discoverTrackCount: 0,
            soulseekResultCount: 0,
            showLibrary: true,
            showDiscover: false,
            showSoulseek: false,
        }),
        true,
    );
});

test("playable catalog results win over a slow acquisition search", () => {
    assert.equal(
        resolvePrimarySongsSurface({
            playableTrackCount: 5,
            soulseekResultCount: 0,
            soulseekSearching: true,
            showSoulseek: true,
        }),
        "playable",
    );
});

test("acquisition results are used only when no instant playable track exists", () => {
    assert.equal(
        resolvePrimarySongsSurface({
            playableTrackCount: 0,
            soulseekResultCount: 3,
            soulseekSearching: false,
            showSoulseek: true,
        }),
        "soulseek",
    );
    assert.equal(
        resolvePrimarySongsSurface({
            playableTrackCount: 0,
            soulseekResultCount: 0,
            soulseekSearching: true,
            showSoulseek: true,
        }),
        "soulseek-loading",
    );
});

test("a background acquisition lookup cannot cover playable catalog rows with a loading screen", () => {
    assert.equal(
        shouldShowSearchLoadingState({
            hasSearched: true,
            anySourceSearching: true,
            hasArtistResult: false,
            discoverResultCount: 0,
            primarySongsSurface: "playable",
        }),
        false,
    );
    assert.equal(
        shouldShowSearchLoadingState({
            hasSearched: true,
            anySourceSearching: true,
            hasArtistResult: false,
            discoverResultCount: 0,
            primarySongsSurface: "soulseek-loading",
        }),
        true,
    );
});
