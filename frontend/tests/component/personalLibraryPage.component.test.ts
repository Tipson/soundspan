import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LucideProps } from "lucide-react";

let tab: string | null = null;
let create: string | null = null;

const Icon = React.forwardRef<SVGSVGElement, LucideProps>((props, ref) =>
    React.createElement("svg", { ...props, ref }),
);
Icon.displayName = "TestIcon";

mock.module("lucide-react", {
    namedExports: {
        Album: Icon,
        ArrowRight: Icon,
        Download: Icon,
        Heart: Icon,
        HardDriveDownload: Icon,
        ListMusic: Icon,
        Loader2: Icon,
        Music2: Icon,
        Plus: Icon,
        RotateCcw: Icon,
        Search: Icon,
        Sparkles: Icon,
        Upload: Icon,
        UserRound: Icon,
    },
});

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: () => undefined,
            replace: () => undefined,
        }),
        useSearchParams: () => ({
            get: (name: string) => (name === "create" ? create : tab),
        }),
    },
});

mock.module("@/features/playlist/components/CreatePlaylistDialog", {
    namedExports: {
        CreatePlaylistDialog: ({ isOpen }: { isOpen: boolean }) =>
            isOpen
                ? React.createElement("div", {
                      "data-testid": "create-playlist-dialog",
                  })
                : null,
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

test("personal Library keeps system collections ahead of loading and error content", async () => {
    const { PersonalPlaylistGrid } =
        await import("../../features/library/components/PersonalPlaylistGrid");
    const { LibraryPlaylistCard } =
        await import("../../features/library/components/LibraryPlaylistCard");

    const leadingCards = React.createElement(
        React.Fragment,
        null,
        React.createElement(LibraryPlaylistCard, {
            href: "/playlist/my-liked",
            title: "Любимые треки",
            trackCount: 24,
            icon: Icon,
            accent: "liked",
        }),
        React.createElement(LibraryPlaylistCard, {
            href: "/library?tab=downloads",
            title: "Загруженное",
            trackCount: 1,
            icon: Icon,
            accent: "downloaded",
        }),
    );

    for (const state of [
        { isLoading: true, isError: false, marker: "animate-pulse" },
        {
            isLoading: false,
            isError: true,
            marker: 'role="alert"',
        },
    ]) {
        const html = renderToStaticMarkup(
            React.createElement(PersonalPlaylistGrid, {
                playlists: [],
                isLoading: state.isLoading,
                isError: state.isError,
                onRetry: () => undefined,
                leadingCards,
            }),
        );

        assert.match(html, /href="\/playlist\/my-liked"/);
        assert.match(html, /href="\/library\?tab=downloads"/);
        assert.match(html, new RegExp(state.marker));
        assert.ok(
            html.indexOf("Любимые треки") < html.indexOf("Загруженное"),
            "Любимые треки должны оставаться первой системной карточкой",
        );
    }
});

mock.module("@/features/device-offline/DeviceOfflineProvider", {
    namedExports: {
        useOptionalDeviceOffline: () => ({
            records: [
                {
                    key: "ready-download",
                    status: "ready",
                    trackIdentity: "yt:ready",
                    integrityVersion: 1,
                },
                {
                    key: "ready-download-other-quality",
                    status: "ready",
                    trackIdentity: "yt:ready",
                },
                {
                    key: "active-download",
                    status: "downloading",
                    trackIdentity: "yt:active",
                },
                {
                    key: "interrupted-download",
                    status: "interrupted",
                    trackIdentity: "yt:interrupted",
                },
                {
                    key: "failed-download",
                    status: "error",
                    trackIdentity: "yt:failed",
                },
            ],
        }),
    },
});

mock.module("@/features/device-offline/components/DownloadsList", {
    namedExports: {
        DownloadsList: () =>
            React.createElement("div", null, "ЗАГРУЗКИ НА УСТРОЙСТВЕ"),
    },
});

test("Library opens one Playlists flow for liked tracks, personal playlists, and device downloads", async () => {
    const { default: LibraryPage } = await import("../../app/library/page");
    tab = null;
    create = null;
    const html = renderToStaticMarkup(React.createElement(LibraryPage));

    assert.match(html, /Моя коллекция/);
    assert.match(html, /Плейлисты/);
    assert.match(html, /data-library-view="playlists"/);
    assert.match(html, /aria-labelledby="playlist-library-title"/);
    assert.match(html, /<h2 id="playlist-library-title"[^>]*>Плейлисты<\/h2>/);
    assert.doesNotMatch(
        html,
        /<span id="playlist-library-title"[^>]*>Любимые треки<\/span>/,
    );
    assert.match(html, /href="\/playlist\/my-liked"/);
    assert.match(html, /href="\/library\?tab=downloads"/);
    assert.match(html, /Evening mix/);
    assert.match(html, /href="\/import"/);
    assert.match(html, />Импортировать плейлист</);
    assert.match(html, />Создать плейлист</);
    assert.doesNotMatch(html, /ЗАГРУЗКИ НА УСТРОЙСТВЕ/);
    assert.match(html, /24 трека/);
    assert.match(html, /1 трек/);
    assert.ok(
        html.indexOf("Любимые треки") < html.indexOf("Загруженное"),
        "Любимые треки должны идти перед Загруженным",
    );
    assert.ok(
        html.indexOf("Загруженное") < html.indexOf("Evening mix"),
        "Статичные коллекции должны идти перед пользовательскими плейлистами",
    );
    assert.doesNotMatch(html, /data-library-overview="split"/);
    assert.doesNotMatch(html, /Сохранено в аккаунте/);
    assert.doesNotMatch(html, /copies stay in this browser/i);
    assert.doesNotMatch(html, /Shuffle Library/);
    assert.doesNotMatch(html, />Owned</);
    assert.doesNotMatch(html, />Discovery</);
});

test("Library owns the playlist creation deep link", async () => {
    const { default: LibraryPage } = await import("../../app/library/page");
    tab = null;
    create = "1";
    const html = renderToStaticMarkup(React.createElement(LibraryPage));
    assert.match(html, /data-testid="create-playlist-dialog"/);
    create = null;
});

test("Library tabs keep saved albums and artists while Downloads opens its own collection", async () => {
    const { default: LibraryPage } = await import("../../app/library/page");

    tab = "albums";
    const albumsHtml = renderToStaticMarkup(React.createElement(LibraryPage));
    assert.match(albumsHtml, /Meteora/);
    assert.match(albumsHtml, /Сохранённые альбомы/);
    assert.match(
        albumsHtml,
        /Загрузки выбираются отдельно на каждом устройстве/,
    );
    assert.match(albumsHtml, /Показать ещё альбомы/);

    tab = "downloads";
    const legacyDownloadsHtml = renderToStaticMarkup(
        React.createElement(LibraryPage),
    );
    assert.match(legacyDownloadsHtml, /data-library-view="downloads"/);
    assert.match(legacyDownloadsHtml, /ЗАГРУЗКИ НА УСТРОЙСТВЕ/);
    assert.doesNotMatch(legacyDownloadsHtml, /Evening mix/);

    tab = "liked";
    const legacyLikedHtml = renderToStaticMarkup(
        React.createElement(LibraryPage),
    );
    assert.match(legacyLikedHtml, /data-library-view="playlists"/);
    assert.match(legacyLikedHtml, /Любимые треки/);
});
