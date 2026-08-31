import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

test("one artist continuation advances every unfinished catalog source", async () => {
    const { ArtistTrackContinuation } =
        await import("../../features/artist/components/ArtistTrackContinuation");
    const calls = { library: 0, provider: 0 };
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(ArtistTrackContinuation, {
                visibleTrackCount: 37,
                library: {
                    loaded: 30,
                    total: 120,
                    isFetching: false,
                    loadMore: () => {
                        calls.library += 1;
                    },
                },
                provider: {
                    loadedReleases: 4,
                    totalReleases: 12,
                    isFetching: false,
                    loadMore: () => {
                        calls.provider += 1;
                    },
                },
            }),
        );
    });

    const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Загрузить следующую часть каталога треков"]',
    );
    assert.ok(button);
    assert.match(button.className, /min-h-11/);
    assert.match(container.textContent ?? "", /Каталог загружается постепенно/);
    assert.match(container.textContent ?? "", /37 треков/);

    await React.act(async () => button.click());
    assert.deepEqual(calls, { library: 1, provider: 1 });

    await React.act(async () => root.unmount());
    container.remove();
});

test("artist continuation is disabled while either source is fetching", async () => {
    const { ArtistTrackContinuation } =
        await import("../../features/artist/components/ArtistTrackContinuation");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(
        React.createElement(ArtistTrackContinuation, {
            visibleTrackCount: 1,
            provider: {
                loadedReleases: 4,
                totalReleases: 8,
                isFetching: true,
                loadMore: () => undefined,
            },
        }),
    );

    assert.match(html, /disabled=""/);
    assert.match(html, /Загружаем треки/);
    assert.match(html, /1 трек/);
});
