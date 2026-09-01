import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", {
            src: String(props.src ?? ""),
            alt: String(props.alt ?? ""),
            className: String(props.className ?? ""),
        }),
});

mock.module("@/components/ui/CoverMosaic", {
    namedExports: {
        CoverMosaic: () => React.createElement("div", null, "Cover mosaic"),
    },
});

test("MusicDetailHero keeps artwork, identity, metadata, and actions in one landmark", async () => {
    const { MusicDetailHero } =
        await import("../../components/music-detail/MusicDetailHero");
    const html = renderToStaticMarkup(
        React.createElement(MusicDetailHero, {
            eyebrow: "Album",
            title: "From Zero",
            artwork: React.createElement("img", {
                src: "/cover.jpg",
                alt: "From Zero cover",
            }),
            artworkShape: "square",
            metadata: React.createElement("span", null, "Linkin Park · 2024"),
            actions: React.createElement("button", null, "Play All"),
        }),
    );

    assert.match(html, /data-music-detail="hero"/);
    assert.match(html, /<h1[^>]*>From Zero<\/h1>/);
    assert.match(html, /From Zero cover/);
    assert.match(html, /Linkin Park · 2024/);
    assert.match(html, /aria-label="Album: действия"/);
    assert.match(html, /Play All/);
});

test("MusicDetailActionDock and TrackSurface expose consistent accessible regions", async () => {
    const { MusicDetailActionDock } =
        await import("../../components/music-detail/MusicDetailActionDock");
    const { MusicDetailTrackSurface } =
        await import("../../components/music-detail/MusicDetailTrackSurface");

    const dockHtml = renderToStaticMarkup(
        React.createElement(
            MusicDetailActionDock,
            { label: "Playlist actions" },
            React.createElement("button", null, "Play"),
        ),
    );
    const tracksHtml = renderToStaticMarkup(
        React.createElement(
            MusicDetailTrackSurface,
            { label: "Playlist tracks" },
            React.createElement("p", null, "Track one"),
        ),
    );

    assert.match(dockHtml, /data-music-detail="actions"/);
    assert.match(dockHtml, /aria-label="Playlist actions"/);
    assert.match(tracksHtml, /data-music-detail="tracks"/);
    assert.match(tracksHtml, /aria-label="Playlist tracks"/);
    assert.match(tracksHtml, /Track one/);
});

test("PlaylistDetailHero uses the shared detail identity without provider jargon", async () => {
    const { PlaylistDetailHero } =
        await import("../../features/playlist/components/PlaylistDetailHero");
    const html = renderToStaticMarkup(
        React.createElement(PlaylistDetailHero, {
            name: "Late-night drive",
            coverUrls: ["/cover.jpg"],
            kindLabel: "Playlist",
            ownerName: "Oleg",
            trackCount: 18,
            durationLabel: "1 hr 4 min",
            isOwner: false,
            actions: React.createElement("button", null, "Play All"),
        }),
    );

    assert.match(html, /data-music-detail="hero"/);
    assert.match(html, /Late-night drive/);
    assert.match(html, /18 треков/);
    assert.match(html, /Oleg/);
    assert.match(html, /Play All/);
    assert.doesNotMatch(html, /TIDAL|YouTube|local \/ /);
});
