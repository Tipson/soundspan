import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("artist view tabs deep-link every view and preserve provider identity", async () => {
    const { ArtistViewTabs } =
        await import("../../features/artist/components/ArtistViewTabs");
    const html = renderToStaticMarkup(
        React.createElement(ArtistViewTabs, {
            activeView: "tracks",
            pathname: "/artist/Massive%20Attack",
            searchParams: "provider=ytmusic&channelId=UCmassiveattack",
        }),
    );

    assert.match(
        html,
        /href="\/artist\/Massive%20Attack\?provider=ytmusic&amp;channelId=UCmassiveattack&amp;view=overview"/,
    );
    assert.match(
        html,
        /<a[^>]*data-state="active"[^>]*aria-current="page"[^>]*href="\/artist\/Massive%20Attack\?provider=ytmusic&amp;channelId=UCmassiveattack&amp;view=tracks"/,
    );
    assert.match(html, />Обзор</);
    assert.match(html, />Треки</);
    assert.match(html, />Альбомы</);
    assert.match(html, />Синглы и EP</);
    assert.match(html, /data-overflow-cue="horizontal"/);
    assert.match(html, /min-h-11/);
});

test("artist view parser falls back to overview for unknown URL values", async () => {
    const { resolveArtistView } =
        await import("../../features/artist/components/ArtistViewTabs");

    assert.equal(resolveArtistView("tracks"), "tracks");
    assert.equal(resolveArtistView("singles"), "singles");
    assert.equal(resolveArtistView("unknown"), "overview");
    assert.equal(resolveArtistView(null), "overview");
});

test("artist release views keep untyped releases with albums and singles explicit", async () => {
    const { filterArtistReleases } =
        await import("../../features/artist/components/ArtistViewTabs");
    const releases = [
        { id: "album", title: "Studio album", type: "Album" },
        { id: "single", title: "Single", type: "Single" },
        { id: "ep", title: "EP", type: "EP" },
        { id: "unknown", title: "Untyped release" },
    ];

    assert.deepEqual(
        filterArtistReleases(releases, "albums").map((release) => release.id),
        ["album", "unknown"],
    );
    assert.deepEqual(
        filterArtistReleases(releases, "singles").map((release) => release.id),
        ["single", "ep"],
    );
    assert.deepEqual(filterArtistReleases(releases, "overview"), releases);
});

test("artist track merge keeps popular order and appends the full library without duplicates", async () => {
    const { mergeArtistTracks } =
        await import("../../features/artist/artistView");
    const popular = [
        {
            id: "popular-1",
            title: "One Step Closer",
            duration: 180,
            artist: { id: "artist-1", name: "Linkin Park" },
        },
    ];
    const library = [
        {
            id: "local-duplicate",
            title: "One Step Closer",
            duration: 180,
            artist: { id: "artist-1", name: "Linkin Park" },
            filePath: "/music/one.flac",
        },
        {
            id: "local-2",
            title: "With You",
            duration: 203,
            artist: { id: "artist-1", name: "Linkin Park" },
            filePath: "/music/two.flac",
        },
    ];

    assert.deepEqual(
        mergeArtistTracks(popular, library).map((track) => track.title),
        ["One Step Closer", "With You"],
    );
});
