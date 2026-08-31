import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = ({ className }: { className?: string }) =>
    React.createElement("svg", { className, "aria-hidden": "true" });

mock.module("lucide-react", {
    namedExports: {
        Album: Icon,
        ArrowRight: Icon,
        Disc3: Icon,
        Download: Icon,
        Heart: Icon,
        ListMusic: Icon,
        Loader2: Icon,
        Music: Icon,
        Play: Icon,
        Trash2: Icon,
        UserRound: Icon,
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", {
            src: String(props.src ?? ""),
            alt: String(props.alt ?? ""),
            className: String(props.className ?? ""),
        }),
});

mock.module("@/hooks/useMetadataDisplay", {
    namedExports: {
        useArtistDisplayData: (artist: Record<string, unknown>) => ({
            name: artist.name,
            summary: artist.bio,
            genres: artist.genres ?? [],
            heroUrl: artist.image,
            hasUserOverrides: false,
        }),
        useAlbumDisplayData: (album: Record<string, unknown>) => ({
            title: album.title,
            year: album.year,
            genres: album.genre ? [album.genre] : [],
            coverUrl: album.coverArt,
            hasUserOverrides: false,
        }),
    },
});

mock.module("@/components/ui/CachedImage", {
    namedExports: {
        CachedImage: (props: Record<string, unknown>) =>
            React.createElement("img", {
                src: String(props.src ?? ""),
                alt: String(props.alt ?? ""),
            }),
    },
});

mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: false,
            trigger: () => undefined,
        }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (value: string) => value,
        },
    },
});

test("catalog heroes preserve complete long titles on 320px layouts", async () => {
    const { ArtistHero } =
        await import("../../features/artist/components/ArtistHero");
    const { AlbumHero } =
        await import("../../features/album/components/AlbumHero");

    const artistHtml = renderToStaticMarkup(
        React.createElement(ArtistHero, {
            artist: {
                id: "artist-1",
                name: "The Artist With A Deliberately Long Unbroken Name",
            },
            source: "discovery",
            albums: [],
            heroImage: null,
            colors: null,
            onReload: () => undefined,
        }),
    );
    const albumHtml = renderToStaticMarkup(
        React.createElement(AlbumHero, {
            album: {
                id: "album-1",
                title: "AnAlbumTitleThatMustNeverLoseItsFirstLetters",
                artist: { id: "artist-1", name: "Artist" },
            },
            source: "discovery",
            coverUrl: null,
            colors: null,
            onReload: () => undefined,
        }),
    );

    assert.match(artistHtml, /flex-col/);
    assert.match(albumHtml, /flex-col/);
    assert.match(artistHtml, /\[overflow-wrap:anywhere\]/);
    assert.match(albumHtml, /\[overflow-wrap:anywhere\]/);
    assert.match(artistHtml, /The Artist With A Deliberately Long/);
    assert.match(albumHtml, /AnAlbumTitleThatMustNeverLoseItsFirstLetters/);
});

test("Library tabs announce horizontal overflow and retain touch-sized targets", async () => {
    const { LibraryTabs } =
        await import("../../features/library/components/LibraryTabs");
    const html = renderToStaticMarkup(
        React.createElement(LibraryTabs, { activeTab: "playlists" }),
    );

    assert.match(html, /data-library-tabs="collection"/);
    assert.match(html, /data-overflow-cue="horizontal"/);
    assert.match(
        html,
        /Прокрутите по горизонтали, чтобы увидеть остальные разделы коллекции/,
    );
    assert.match(html, /min-h-11/);
    assert.match(html, /snap-x/);
    assert.equal((html.match(/data-library-tab=/g) ?? []).length, 3);
    for (const label of ["Плейлисты", "Альбомы", "Исполнители"]) {
        assert.match(html, new RegExp(`>${label}<`));
    }
    assert.doesNotMatch(html, /href="\/library\?tab=liked"/);
    assert.doesNotMatch(html, /href="\/library\?tab=downloads"/);
    assert.doesNotMatch(html, />Обзор</);
});

test("Library overview makes account and device ownership explicit", async () => {
    const { LibraryOverview } =
        await import("../../features/library/components/LibraryOverview");
    const html = renderToStaticMarkup(
        React.createElement(LibraryOverview, {
            likedTotal: 42,
            playlistTotal: 3,
            albumTotal: 8,
            artistTotal: 5,
            downloadTotal: 2,
        }),
    );

    assert.match(html, /Сохранено в аккаунте/);
    assert.match(html, /Доступно на всех устройствах, где вы вошли в аккаунт/);
    assert.match(html, /Загрузки на этом устройстве/);
    assert.match(html, /2 офлайн-трека/);
    assert.match(html, /data-library-overview="split"/);
    assert.match(html, /data-library-scope="account"/);
    assert.match(html, /data-library-scope="device"/);
});

test("legacy Library grids keep complete titles and named 44px card actions", async () => {
    const { AlbumsGrid } =
        await import("../../features/library/components/AlbumsGrid");
    const { ArtistsGrid } =
        await import("../../features/library/components/ArtistsGrid");

    const albumHtml = renderToStaticMarkup(
        React.createElement(AlbumsGrid, {
            albums: [
                {
                    id: "album-1",
                    title: "Очень длинное название альбома без потери смысла",
                    artist: { id: "artist-1", name: "Исполнитель" },
                },
            ],
            onPlay: async () => undefined,
            onDelete: () => undefined,
            canDelete: true,
        }),
    );
    const artistHtml = renderToStaticMarkup(
        React.createElement(ArtistsGrid, {
            artists: [
                {
                    id: "artist-1",
                    name: "Очень длинное имя исполнителя без обрезания",
                },
            ],
            onPlay: async () => undefined,
            onDelete: () => undefined,
            canDelete: true,
        }),
    );

    for (const [html, labels] of [
        [
            albumHtml,
            [
                "Воспроизвести альбом «Очень длинное название альбома без потери смысла»",
                "Удалить альбом «Очень длинное название альбома без потери смысла»",
            ],
        ],
        [
            artistHtml,
            [
                "Воспроизвести исполнителя «Очень длинное имя исполнителя без обрезания»",
                "Удалить исполнителя «Очень длинное имя исполнителя без обрезания»",
            ],
        ],
    ] as const) {
        assert.match(html, /line-clamp-2/);
        for (const label of labels) {
            const button = html.match(
                new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`),
            )?.[0];
            assert.ok(button, `missing ${label}`);
            assert.match(button, /h-11 w-11/);
        }
    }
});
