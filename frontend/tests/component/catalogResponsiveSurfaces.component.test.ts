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
        Music: Icon,
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
        React.createElement(LibraryTabs, { activeTab: "overview" }),
    );

    assert.match(html, /data-overflow-cue="horizontal"/);
    assert.match(html, /Scroll horizontally for more Library sections/);
    assert.match(html, /min-h-11/);
    assert.match(html, /snap-x/);
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

    assert.match(html, /Saved to your account/);
    assert.match(html, /Available on every signed-in device/);
    assert.match(html, /Only on this device/);
    assert.match(html, /2 offline tracks/);
});
