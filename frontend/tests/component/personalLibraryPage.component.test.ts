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

    assert.match(playlists, />Повторить</);
    assert.match(playlists, /min-h-11/);
    assert.match(albums, />Повторить</);
    assert.match(albums, /min-h-11/);
});

mock.module("@/features/device-offline/DeviceOfflineProvider", {
    namedExports: {
        useDeviceOffline: () => ({
            records: [
                {
                    key: "ready-download",
                    status: "ready",
                    integrityVersion: 1,
                },
                { key: "active-download", status: "downloading" },
                { key: "interrupted-download", status: "interrupted" },
                { key: "failed-download", status: "error" },
            ],
        }),
    },
});

mock.module("@/features/device-offline/components/DownloadsList", {
    namedExports: {
        DownloadsList: () => React.createElement("div", null, "ЗАГРУЗКИ НА УСТРОЙСТВЕ"),
    },
});

test("Library overview is a personal collection hub without server catalog controls", async () => {
    const { default: LibraryPage } = await import("../../app/library/page");
    tab = null;
    const html = renderToStaticMarkup(React.createElement(LibraryPage));

    assert.match(html, /Моя коллекция/);
    assert.match(html, /Любимые треки/);
    assert.match(html, /Плейлисты/);
    assert.match(html, /Сохранённые альбомы/);
    assert.match(html, /Сохранённые исполнители/);
    assert.match(html, /Показать все/);
    assert.match(html, /Загрузки на этом устройстве/);
    assert.match(html, /Сохранено в аккаунте/);
    assert.match(html, /Только на этом устройстве/);
    assert.match(html, /обычными файлами/i);
    assert.match(html, /профилю браузера/i);
    assert.match(html, /очистка данных сайта не удаляет/i);
    assert.match(html, /1 офлайн-трек/);
    assert.doesNotMatch(html, /4 офлайн-трека/);
    assert.doesNotMatch(html, /copies stay in this browser/i);
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
    assert.match(albumsHtml, /Сохранённые альбомы/);
    assert.match(albumsHtml, /Загрузки выбираются отдельно на каждом устройстве/);
    assert.match(albumsHtml, /Показать ещё альбомы/);

    tab = "downloads";
    const downloadsHtml = renderToStaticMarkup(
        React.createElement(LibraryPage),
    );
    assert.match(downloadsHtml, /ЗАГРУЗКИ НА УСТРОЙСТВЕ/);
    assert.match(downloadsHtml, /обычными файлами/i);
    assert.match(downloadsHtml, /профилю браузера/i);
    assert.doesNotMatch(downloadsHtml, /stored only in this browser/i);
    assert.match(downloadsHtml, /очистка данных сайта не удаляет/i);
});
