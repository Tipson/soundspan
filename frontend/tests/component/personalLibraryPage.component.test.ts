import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

let tab: string | null = null;

const Icon = () => React.createElement("i");

mock.module("lucide-react", {
    namedExports: {
        Album: Icon,
        ArrowRight: Icon,
        Download: Icon,
        Heart: Icon,
        ListMusic: Icon,
        Loader2: Icon,
        Music2: Icon,
        RotateCcw: Icon,
        Search: Icon,
        Sparkles: Icon,
        UserRound: Icon,
    },
});

mock.module("next/navigation", {
    namedExports: {
        useSearchParams: () => ({ get: () => tab }),
    },
});

mock.module("@/hooks/useQueries", {
    namedExports: {
        usePlaylistsQuery: () => ({
            data: [
                {
                    id: "playlist-1",
                    name: "Evening mix",
                    trackCount: 12,
                    isOwner: true,
                    isHidden: false,
                    items: [],
                },
            ],
            isLoading: false,
            isError: false,
            refetch: async () => undefined,
        }),
        useLikedPlaylistQuery: () => ({
            data: { total: 24, tracks: [] },
            isLoading: false,
            isError: false,
        }),
    },
});

mock.module("@/features/library/hooks/useSavedMusic", {
    namedExports: {
        useSavedMusicEntities: (type: "album" | "artist") => ({
            items:
                type === "album"
                    ? [
                          {
                              id: "saved-album",
                              entityType: "album",
                              source: "ytmusic",
                              entityId: "MPREb_example",
                              title: "Meteora",
                              subtitle: "Linkin Park",
                              imageUrl: null,
                          },
                      ]
                    : [
                          {
                              id: "saved-artist",
                              entityType: "artist",
                              source: "ytmusic",
                              entityId: "UC_example",
                              title: "Linkin Park",
                              subtitle: null,
                              imageUrl: null,
                          },
                      ],
            total: 1,
            isLoading: false,
            isError: false,
            hasNextPage: true,
            isFetchingNextPage: false,
            fetchNextPage: async () => undefined,
            refetch: async () => undefined,
        }),
    },
});

test("personal Library failures provide touch-sized retry actions", async () => {
    const { PersonalPlaylistGrid } =
        await import("../../features/library/components/PersonalPlaylistGrid");
    const { SavedMusicGrid } =
        await import("../../features/library/components/SavedMusicGrid");

    const playlists = renderToStaticMarkup(
        React.createElement(PersonalPlaylistGrid, {
            playlists: [],
            isLoading: false,
            isError: true,
            onRetry: () => undefined,
        }),
    );
    const albums = renderToStaticMarkup(
        React.createElement(SavedMusicGrid, {
            type: "album",
            items: [],
            isLoading: false,
            isError: true,
            onRetry: () => undefined,
        }),
    );

    assert.match(playlists, />Retry</);
    assert.match(playlists, /min-h-11/);
    assert.match(albums, />Retry</);
    assert.match(albums, /min-h-11/);
});

mock.module("@/features/device-offline/DeviceOfflineProvider", {
    namedExports: {
        useDeviceOffline: () => ({ records: [{ key: "download-1" }] }),
    },
});

mock.module("@/features/device-offline/components/DownloadsList", {
    namedExports: {
        DownloadsList: () => React.createElement("div", null, "DEVICE COPIES"),
    },
});

test("Library overview is a personal collection hub without server catalog controls", async () => {
    const { default: LibraryPage } = await import("../../app/library/page");
    tab = null;
    const html = renderToStaticMarkup(React.createElement(LibraryPage));

    assert.match(html, /Your Library/);
    assert.match(html, /Liked songs/);
    assert.match(html, /Playlists/);
    assert.match(html, /Saved albums/);
    assert.match(html, /Saved artists/);
    assert.match(html, /Downloads on this device/);
    assert.match(html, /Saved to your account/);
    assert.match(html, /Only on this device/);
    assert.match(html, /Meteora/);
    assert.match(html, /Linkin Park/);
    assert.doesNotMatch(html, /Shuffle Library/);
    assert.doesNotMatch(html, />Owned</);
    assert.doesNotMatch(html, />Discovery</);
});

test("Library tabs expose account-saved entities and existing device downloads", async () => {
    const { default: LibraryPage } = await import("../../app/library/page");

    tab = "albums";
    const albumsHtml = renderToStaticMarkup(React.createElement(LibraryPage));
    assert.match(albumsHtml, /Meteora/);
    assert.match(albumsHtml, /Saved albums stay with your account/);
    assert.match(albumsHtml, /Load more albums/);

    tab = "downloads";
    const downloadsHtml = renderToStaticMarkup(
        React.createElement(LibraryPage),
    );
    assert.match(downloadsHtml, /DEVICE COPIES/);
});
