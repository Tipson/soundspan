import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiscoverPlaylist } from "../../features/discover/types";

mock.module("@/components/ui/CoverMosaic", {
    namedExports: {
        CoverMosaic: ({ coverUrls }: { coverUrls: string[] }) =>
            React.createElement(
                "div",
                { "data-discover-covers": true },
                ...coverUrls.map((src) =>
                    React.createElement("img", { key: src, src, alt: "" }),
                ),
            ),
    },
});
mock.module("@/lib/api", {
    namedExports: {
        api: { getCoverArtUrl: (url: string) => `/cover/${url}` },
    },
});

test("weekly discovery artwork comes from its actual playlist and retains factual metadata", async () => {
    const { DiscoverHero } =
        await import("../../features/discover/components/DiscoverHero");
    const playlist = {
        weekStart: "2026-10-12",
        totalCount: 40,
        tracks: [
            { coverUrl: "album-a", duration: 180 },
            { coverUrl: null, duration: 180 },
            { coverUrl: "album-b", duration: 180 },
        ],
    } as DiscoverPlaylist;
    const html = renderToStaticMarkup(
        React.createElement(DiscoverHero, { playlist, config: null }),
    );
    assert.match(html, /data-discover-covers/);
    assert.match(html, /src="\/cover\/album-a"/);
    assert.match(html, /src="\/cover\/album-b"/);
    assert.match(html, /Открытия недели/);
    assert.match(html, /40 треков/);
});

test("discovery loading header does not invent playlist covers or track counts", async () => {
    const { DiscoverHero } =
        await import("../../features/discover/components/DiscoverHero");
    const html = renderToStaticMarkup(
        React.createElement(DiscoverHero, { playlist: null, config: null }),
    );
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /40 треков/);
    assert.match(html, /Открытия недели/);
});
