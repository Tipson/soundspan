import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
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
            discoverTrackDisplayLimit: 10,
        },
    );
    assert.deepEqual(
        resolveSearchCatalogPolicy({
            isTracksView: true,
        }),
        {
            discoverType: "music",
            discoverLimit: 50,
            discoverTrackDisplayLimit: null,
        },
    );
});

test("dedicated album and artist views request the expanded provider catalog", () => {
    for (const view of ["albums", "artists"] as const) {
        assert.equal(
            resolveSearchCatalogPolicy({
                isTracksView: false,
                isAlbumsView: view === "albums",
                isArtistsView: view === "artists",
            }).discoverLimit,
            50,
        );
    }
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

test("the single-column page renders playable songs before acquisition fallbacks", async () => {
    const source = await readFile(
        new URL("../../app/search/page.tsx", import.meta.url),
        "utf8",
    );
    const branchStart = source.indexOf(
        "Original single-column layout when not showing 2-column",
    );
    const branchEnd = source.indexOf("{/* Library Albums */}", branchStart);
    assert.ok(branchStart >= 0 && branchEnd > branchStart);
    const singleColumnBranch = source.slice(branchStart, branchEnd);

    const playableIndex = singleColumnBranch.indexOf(
        'primarySongsSurface === "playable"',
    );
    const acquisitionIndex = singleColumnBranch.indexOf(
        'primarySongsSurface === "soulseek"',
    );
    assert.ok(playableIndex >= 0, "playable single-column surface is missing");
    assert.ok(
        acquisitionIndex > playableIndex,
        "Soulseek must not precede instantly playable catalog rows",
    );
    assert.match(
        singleColumnBranch,
        /primarySongsSurface === "soulseek-loading"/,
    );
});

test("the primary search surface stays music-only when no audiobook catalog is configured", async () => {
    const source = await readFile(
        new URL("../../app/search/page.tsx", import.meta.url),
        "utf8",
    );

    assert.doesNotMatch(source, /LibraryAudiobooksGrid/);
    assert.doesNotMatch(source, /LibraryPodcastsGrid/);
    assert.doesNotMatch(source, /DiscoverPodcastsGrid/);
    assert.doesNotMatch(source, />Audiobooks</);
    assert.doesNotMatch(source, />Discover Podcasts</);
});
