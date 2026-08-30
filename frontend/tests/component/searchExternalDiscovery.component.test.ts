import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("lucide-react", {
    namedExports: {
        Music: () => React.createElement("svg", { "data-icon": "music" }),
        Disc3: () => React.createElement("svg", { "data-icon": "disc" }),
        ArrowUpRight: () =>
            React.createElement("svg", { "data-icon": "arrow-up-right" }),
    },
});

mock.module("next/image", {
    defaultExport: ({
        alt,
        src,
        loading,
        fetchPriority,
        sizes,
    }: {
        alt?: string;
        src?: string;
        loading?: string;
        fetchPriority?: string;
        sizes?: string;
    }) =>
        React.createElement("img", {
            alt,
            src,
            loading,
            fetchPriority,
            sizes,
        }),
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => `/proxied/${url}`,
            getBrowseImageUrl: (url: string) => `/browse-proxied/${url}`,
            getTidalStreamingStatus: async () => ({
                enabled: false,
                available: false,
                authenticated: false,
                credentialsConfigured: false,
            }),
            getYtMusicStatus: async () => ({
                enabled: false,
                available: false,
                authenticated: false,
                credentialsConfigured: false,
            }),
            matchTidalBatch: async () => ({ matches: [] }),
            matchYtMusicBatch: async () => ({ matches: [] }),
            addTrackToPlaylist: async () => undefined,
        },
    },
});

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({ push: () => undefined }),
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: () => undefined,
            playNext: () => undefined,
            addToQueue: () => undefined,
            playTrack: () => undefined,
            startVibeMode: async () => ({ success: true, trackCount: 0 }),
        }),
    },
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: { TidalBadge: () => null },
});
mock.module("@/components/ui/YouTubeBadge", {
    namedExports: { YouTubeBadge: () => null },
});
mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: {
        TrackOverflowMenu: () =>
            React.createElement("button", { "aria-haspopup": "menu" }),
    },
});

mock.module("@/components/ui/PeerBadge", {
    namedExports: {
        PeerBadge: () => React.createElement("span"),
    },
});

mock.module("@/lib/format", {
    namedExports: {
        formatListeners: (value: number) => String(value),
    },
});

const libraryArtist = {
    id: "lib-1",
    name: "Nick Drake",
    heroUrl: "",
};

const discoveryArtist = {
    type: "music",
    name: "Drake",
    mbid: "b49b81cc-d5b7-4bdd-aadb-385df8de69a6",
    image: "",
};

async function renderTopResult(preferDiscovery: boolean) {
    const { TopResult } =
        await import("../../features/search/components/TopResult");
    return renderToStaticMarkup(
        React.createElement(TopResult, {
            libraryArtist,
            discoveryArtist,
            preferDiscovery,
        } as never),
    );
}

test("top result prefers the library artist by default", async () => {
    const html = await renderTopResult(false);
    assert.match(html, /Nick Drake/);
    assert.match(html, /href="\/artist\/lib-1"/);
});

test("top result prefers an exact external match when asked", async () => {
    const html = await renderTopResult(true);
    assert.match(html, />Drake</);
    assert.match(html, /href="\/artist\/b49b81cc-d5b7-4bdd-aadb-385df8de69a6"/);
    assert.doesNotMatch(html, /Nick Drake/);
});

test("top result prioritizes its above-the-fold artist artwork at the rendered sizes", async () => {
    const { TopResult } =
        await import("../../features/search/components/TopResult");
    const html = renderToStaticMarkup(
        React.createElement(TopResult, {
            discoveryArtist: {
                type: "music",
                name: "Massive Attack",
                image: "https://img/massive-attack.jpg",
            },
        } as never),
    );

    assert.match(html, /loading="eager"/);
    assert.match(html, /fetchPriority="high"/);
    assert.match(html, /sizes="\(min-width: 640px\) 112px, 96px"/);
});

test("YouTube Music-only artists keep their provider channel route identity", async () => {
    const { TopResult } =
        await import("../../features/search/components/TopResult");
    const html = renderToStaticMarkup(
        React.createElement(TopResult, {
            discoveryArtist: {
                type: "music",
                name: "Massive Attack",
                youtubeChannelId: "UCmassiveattack",
            },
        } as never),
    );

    assert.match(
        html,
        /href="\/artist\/Massive%20Attack\?provider=ytmusic&amp;channelId=UCmassiveattack"/,
    );
});

test("YouTube Music-only related artists use the provider-aware artist route", async () => {
    const { SimilarArtistsGrid } =
        await import("../../features/search/components/SimilarArtistsGrid");
    const html = renderToStaticMarkup(
        React.createElement(SimilarArtistsGrid, {
            similarArtists: [
                {
                    type: "music",
                    name: "Portishead",
                    youtubeChannelId: "UCportishead",
                    provider: "ytmusic",
                },
            ],
        } as never),
    );

    assert.match(
        html,
        /href="\/artist\/Portishead\?provider=ytmusic&amp;channelId=UCportishead"/,
    );
});

test("search artists keep one exact duplicate and prefer its canonical provider route", async () => {
    const { SearchArtistsGrid } =
        await import("../../features/search/components/SearchArtistsGrid");
    const html = renderToStaticMarkup(
        React.createElement(SearchArtistsGrid, {
            libraryArtists: [
                { id: "local-portishead", name: "Portishead", heroUrl: "" },
            ],
            discoveryArtists: [
                {
                    type: "music",
                    name: "Portishead",
                    youtubeChannelId: "UCduplicate",
                },
                {
                    type: "music",
                    name: "Massive Attack",
                    youtubeChannelId: "UCmassiveattack",
                },
            ],
            limit: 2,
        } as never),
    );

    assert.doesNotMatch(html, /href="\/artist\/local-portishead"/);
    assert.match(
        html,
        /href="\/artist\/Portishead\?provider=ytmusic&amp;channelId=UCduplicate"/,
    );
    assert.match(
        html,
        /href="\/artist\/Massive%20Attack\?provider=ytmusic&amp;channelId=UCmassiveattack"/,
    );
    assert.equal((html.match(/>Portishead</g) ?? []).length, 1);
});

test("discover tracks render artist links and album context", async () => {
    const { DiscoverTracksList } =
        await import("../../features/search/components/DiscoverTracksList");
    const html = renderToStaticMarkup(
        React.createElement(DiscoverTracksList, {
            tracks: [
                {
                    type: "track",
                    id: "t1",
                    name: "Headlines",
                    artist: "Drake",
                    album: "Take Care",
                    image: "",
                },
                {
                    type: "track",
                    id: "t2",
                    name: "Orphan Song",
                    artist: "",
                    album: null,
                    image: "",
                },
            ],
        } as never),
    );

    // Rows are play/navigate buttons now, not bare artist links; unmatched
    // rows expose the artist destination through their accessible label.
    assert.match(html, /Headlines/);
    assert.match(html, /Drake — Take Care/);
    assert.match(html, /aria-label="Go to Drake"/);
    assert.match(html, /Orphan Song/);
    assert.doesNotMatch(html, /href="\/artist\//);
});

test("provider albums link to the existing playable YouTube Music album page", async () => {
    const { ProviderAlbumsGrid } =
        await import("../../features/search/components/ProviderAlbumsGrid");
    const html = renderToStaticMarkup(
        React.createElement(ProviderAlbumsGrid, {
            albums: [
                {
                    type: "album",
                    id: "MPREb_mezzanine",
                    browseId: "MPREb_mezzanine",
                    name: "Mezzanine",
                    artist: "Massive Attack",
                    image: "https://img/mezzanine.jpg",
                    year: "1998",
                    provider: "ytmusic",
                },
            ],
        } as never),
    );

    assert.match(
        html,
        /href="\/explore\/yt-playlist\/MPREb_mezzanine\?type=album"/,
    );
    assert.match(html, /Mezzanine/);
    assert.match(html, /Massive Attack/);
    assert.match(html, /1998/);
    assert.match(html, /\/browse-proxied\/https:\/\/img\/mezzanine.jpg/);
});
