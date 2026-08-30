import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    query: "massive attack",
    view: null as string | null,
    libraryTracks: [] as unknown[],
    libraryAlbums: [] as unknown[],
    libraryArtists: [] as unknown[],
    discoverResults: [] as unknown[],
    isDiscoverSearching: false,
};

const calls = {
    searchData: [] as Array<Record<string, unknown>>,
    topResult: [] as Array<Record<string, unknown>>,
    libraryTrackLimits: [] as Array<number | null | undefined>,
    discoverTrackLimits: [] as Array<number | null | undefined>,
    libraryAlbumLimits: [] as Array<number | null | undefined>,
    providerAlbumLimits: [] as Array<number | null | undefined>,
    libraryAlbumIds: [] as string[][],
    providerAlbumIds: [] as string[][],
    embeddedAlbumGrids: [] as Array<boolean | undefined>,
};

function marker(label: string) {
    const Component = () => React.createElement("div", null, label);
    Component.displayName = `Mock${label.replace(/[^a-zA-Z0-9]/g, "")}`;
    return Component;
}

function localTrack(id: number) {
    return {
        id: `local-${id}`,
        title: `Local ${id}`,
        duration: 180,
        album: {
            id: `album-${id}`,
            title: `Album ${id}`,
            artist: { id: "local-artist", name: "Massive Attack" },
        },
    };
}

function discoverTrack(id: number) {
    return {
        type: "track",
        id: `video-${id}`,
        name: `Discover ${id}`,
        artist: "Massive Attack",
        youtubeVideoId: `video-${id}`,
        streamSource: "youtube",
    };
}

function localAlbum(id: number) {
    return {
        id: `local-album-${id}`,
        title: `Local Album ${id}`,
        artist: { name: "Massive Attack" },
    };
}

function providerAlbum(id: number) {
    return {
        type: "album",
        id: `provider-album-${id}`,
        browseId: `provider-album-${id}`,
        name: `Provider Album ${id}`,
        artist: "Massive Attack",
    };
}

mock.module("next/navigation", {
    namedExports: {
        useSearchParams: () => ({
            get: (name: string) => {
                if (name === "q") return state.query;
                if (name === "view") return state.view;
                return null;
            },
        }),
        useRouter: () => ({ push: () => undefined }),
    },
});

mock.module("lucide-react", {
    namedExports: {
        SearchIcon: marker("search-icon"),
    },
});

mock.module("@/features/search/hooks/useSearchData", {
    namedExports: {
        useSearchData: (input: Record<string, unknown>) => {
            calls.searchData.push(input);
            return {
                libraryResults: {
                    tracks: state.libraryTracks,
                    albums: state.libraryAlbums,
                    artists: state.libraryArtists,
                },
                discoverResults: state.discoverResults,
                similarArtists: [],
                aliasInfo: null,
                isLibrarySearching: false,
                isDiscoverSearching: state.isDiscoverSearching,
                hasSearched: true,
            };
        },
    },
});

mock.module("@/features/search/hooks/useSoulseekSearch", {
    namedExports: {
        useSoulseekSearch: () => ({
            soulseekResults: [],
            isSoulseekSearching: false,
            isSoulseekPolling: false,
            soulseekEnabled: false,
            downloadingFiles: new Set<string>(),
            handleDownload: async () => undefined,
        }),
    },
});

mock.module("@/features/search/hooks/useYouTubeUrl", {
    namedExports: {
        useYouTubeUrl: () => ({
            videoInfo: null,
            isLoading: false,
            isDownloading: false,
            downloadProgress: 0,
            handlePlay: () => undefined,
            handleDownload: () => undefined,
        }),
    },
});

mock.module("@/features/search/hooks/useYouTubePlaylist", {
    namedExports: {
        useYouTubePlaylist: () => ({
            playlistInfo: null,
            isLoading: false,
            error: null,
            isDownloading: false,
            progress: null,
            handleDownloadAll: () => undefined,
            handleCancel: () => undefined,
        }),
    },
});

mock.module("@/features/search/components/TopResult", {
    namedExports: {
        TopResult: (props: Record<string, unknown>) => {
            calls.topResult.push(props);
            return React.createElement("div", null, "top-result");
        },
    },
});
mock.module("@/features/search/components/EmptyState", {
    namedExports: { EmptyState: () => null },
});
mock.module("@/features/search/components/LibraryTracksList", {
    namedExports: {
        LibraryTracksList: ({ limit }: { limit?: number | null }) => {
            calls.libraryTrackLimits.push(limit);
            return React.createElement("div", null, "library-tracks");
        },
    },
});
mock.module("@/features/search/components/DiscoverTracksList", {
    namedExports: {
        DiscoverTracksList: ({ limit }: { limit?: number | null }) => {
            calls.discoverTrackLimits.push(limit);
            return React.createElement("div", null, "discover-tracks");
        },
    },
});
mock.module("@/features/search/components/LibraryAlbumsGrid", {
    namedExports: {
        LibraryAlbumsGrid: ({
            albums,
            limit,
            embedded,
        }: {
            albums: Array<{ id: string }>;
            limit?: number | null;
            embedded?: boolean;
        }) => {
            calls.libraryAlbumLimits.push(limit);
            calls.libraryAlbumIds.push(albums.map((album) => album.id));
            calls.embeddedAlbumGrids.push(embedded);
            return React.createElement("div", null, "library-albums");
        },
    },
});
mock.module("@/features/search/components/ProviderAlbumsGrid", {
    namedExports: {
        ProviderAlbumsGrid: ({
            albums,
            limit,
            embedded,
        }: {
            albums: Array<{ browseId?: string; id?: string }>;
            limit?: number | null;
            embedded?: boolean;
        }) => {
            calls.providerAlbumLimits.push(limit);
            calls.providerAlbumIds.push(
                albums.map((album) => album.browseId ?? album.id ?? ""),
            );
            calls.embeddedAlbumGrids.push(embedded);
            return React.createElement("div", null, "provider-albums");
        },
    },
});
mock.module("@/features/search/components/SearchArtistsGrid", {
    namedExports: { SearchArtistsGrid: marker("search-artists") },
});
mock.module("@/features/search/components/SimilarArtistsGrid", {
    namedExports: { SimilarArtistsGrid: marker("similar-artists") },
});
mock.module("@/features/search/components/AliasResolutionBanner", {
    namedExports: { AliasResolutionBanner: marker("alias-banner") },
});
mock.module("@/features/search/components/SoulseekSongsList", {
    namedExports: { SoulseekSongsList: marker("soulseek-results") },
});
mock.module("@/features/search/components/TVSearchInput", {
    namedExports: { TVSearchInput: marker("tv-search") },
});
mock.module("@/features/search/components/YouTubePreviewCard", {
    namedExports: { YouTubePreviewCard: marker("youtube-preview") },
});
mock.module("@/features/search/components/YouTubePlaylistPreviewCard", {
    namedExports: {
        YouTubePlaylistPreviewCard: marker("youtube-playlist-preview"),
    },
});
mock.module("@/lib/auth-context", {
    namedExports: { useAuth: () => ({ user: { role: "user" } }) },
});
mock.module("@/lib/features-context", {
    namedExports: { useFeatures: () => ({ federation: false }) },
});

beforeEach(() => {
    state.query = "massive attack";
    state.view = null;
    state.libraryTracks = Array.from({ length: 3 }, (_, index) =>
        localTrack(index),
    );
    state.libraryAlbums = Array.from({ length: 4 }, (_, index) =>
        localAlbum(index),
    );
    state.libraryArtists = [
        { id: "local-artist", name: "Massive Attack", heroUrl: "" },
    ];
    state.discoverResults = [
        ...Array.from({ length: 8 }, (_, index) => discoverTrack(index)),
        ...Array.from({ length: 4 }, (_, index) => providerAlbum(index)),
    ];
    state.isDiscoverSearching = false;
    calls.searchData.length = 0;
    calls.topResult.length = 0;
    calls.libraryTrackLimits.length = 0;
    calls.discoverTrackLimits.length = 0;
    calls.libraryAlbumLimits.length = 0;
    calls.providerAlbumLimits.length = 0;
    calls.libraryAlbumIds.length = 0;
    calls.providerAlbumIds.length = 0;
    calls.embeddedAlbumGrids.length = 0;
});

test("All opens the canonical provider artist when an exact local shadow duplicates it", async () => {
    state.libraryArtists = [
        { id: "local-shadow", name: "Rammstein", heroUrl: "" },
    ];
    state.discoverResults = [
        {
            type: "music",
            name: "Rammstein",
            youtubeChannelId: "UCrammstein",
            provider: "ytmusic",
        },
    ];
    state.query = "Rammstein";

    const SearchPage = (await import("../../app/search/page")).default;
    renderToStaticMarkup(React.createElement(SearchPage));

    assert.equal(calls.topResult.length, 1);
    assert.equal(calls.topResult[0]?.preferDiscovery, true);
});

test("All replaces an exact local album shadow with one canonical provider card", async () => {
    state.libraryAlbums = [
        {
            id: "local-from-zero",
            title: "From Zero",
            artist: { name: "Linkin Park" },
        },
    ];
    state.discoverResults = [
        {
            type: "album",
            name: "From Zero",
            artist: "Linkin Park",
            browseId: "MPREb_from-zero",
            provider: "ytmusic",
        },
    ];

    const SearchPage = (await import("../../app/search/page")).default;
    renderToStaticMarkup(React.createElement(SearchPage));

    assert.deepEqual(calls.libraryAlbumIds, []);
    assert.deepEqual(calls.providerAlbumIds, [["MPREb_from-zero"]]);
});

test("All renders an explicit five-track continuation and one six-album shelf", async () => {
    const SearchPage = (await import("../../app/search/page")).default;
    const html = renderToStaticMarkup(React.createElement(SearchPage));

    assert.match(html, />Tracks<\/h2>/);
    assert.match(
        html,
        /href="\/search\?q=massive%20attack&amp;view=tracks"[^>]*>Show all<\/a>/,
    );
    assert.deepEqual(calls.libraryTrackLimits, [3]);
    assert.deepEqual(calls.discoverTrackLimits, [2]);
    assert.deepEqual(calls.libraryAlbumLimits, [4]);
    assert.deepEqual(calls.providerAlbumLimits, [2]);
    assert.deepEqual(calls.embeddedAlbumGrids, [true, true]);
    assert.equal(calls.searchData[0]?.libraryType, "all");
    assert.equal(calls.searchData[0]?.libraryLimit, 20);
});

test("Tracks requests and renders at most fifty tracks without artist hero", async () => {
    state.view = "tracks";
    state.libraryTracks = Array.from({ length: 40 }, (_, index) =>
        localTrack(index),
    );
    state.discoverResults = Array.from({ length: 30 }, (_, index) =>
        discoverTrack(index),
    );
    const SearchPage = (await import("../../app/search/page")).default;
    const html = renderToStaticMarkup(React.createElement(SearchPage));

    assert.equal(calls.searchData[0]?.libraryType, "tracks");
    assert.equal(calls.searchData[0]?.libraryLimit, 50);
    assert.equal(calls.searchData[0]?.discoverLimit, 50);
    assert.deepEqual(calls.libraryTrackLimits, [40]);
    assert.deepEqual(calls.discoverTrackLimits, [10]);
    assert.doesNotMatch(
        html,
        /top-result|Show all|library-albums|search-artists/,
    );
});

test("partial local results disclose that the online catalog is still loading", async () => {
    state.isDiscoverSearching = true;
    state.discoverResults = [];

    const SearchPage = (await import("../../app/search/page")).default;
    const html = renderToStaticMarkup(React.createElement(SearchPage));

    assert.match(html, /Searching online catalog/);
});
