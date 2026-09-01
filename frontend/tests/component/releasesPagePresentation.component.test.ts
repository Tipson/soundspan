import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/lib/download-context", {
    namedExports: { useDownloadContext: () => ({ downloadsEnabled: false }) },
});

mock.module("@/hooks/useMusicRequests", {
    namedExports: {
        openRequestRgMbids: () => new Set<string>(),
        useCreateMusicRequest: () => ({
            isPending: false,
            mutateAsync: async () => ({}),
        }),
        useMyMusicRequests: () => ({ data: [] }),
        useRequestsGate: () => ({ requestsEnabled: true }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            request: async () => ({
                upcoming: [],
                recent: [],
                monitoredArtistCount: 0,
                similarArtistCount: 0,
            }),
            downloadAlbum: async () => ({}),
        },
    },
});

test("release radar keeps its header visible while content loads", async () => {
    const { default: ReleasesPage } = await import("../../app/releases/page");
    const html = renderToStaticMarkup(React.createElement(ReleasesPage));

    assert.match(html, /data-utility-page="releases"/);
    assert.match(html, /data-page-header="editorial"/);
    assert.match(html, /Новинки и будущие релизы/);
    assert.match(html, /Загружаем релизы/);
    assert.match(html, /role="status"/);
});
