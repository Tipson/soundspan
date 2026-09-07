import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({
    settings: {
        disableCSSFileLoading: true,
        disableJavaScriptFileLoading: true,
    },
});
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());
let imageError: (() => void) | undefined;
mock.module("next/image", {
    defaultExport: ({ src, onError }: React.ComponentProps<"img">) => {
        imageError = () =>
            onError?.({} as React.SyntheticEvent<HTMLImageElement>);
        return React.createElement("span", { "data-image-src": src });
    },
});
mock.module("next/link", {
    defaultExport: ({ children, ...props }: React.ComponentProps<"a">) =>
        React.createElement("a", props, children),
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) =>
                `/cover?url=${encodeURIComponent(url)}`,
        },
    },
});

test("top result recovers missing local artwork from the exact matching artist only", async () => {
    const { TopResult } =
        await import("../../features/search/components/TopResult");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = async (name: string) => {
        await React.act(async () =>
            root.render(
                React.createElement(TopResult, {
                    libraryArtist: {
                        id: "local",
                        name: "Linkin Park",
                        heroUrl: "native:artists/local.jpg",
                    },
                    discoveryArtist: {
                        type: "music",
                        name,
                        image: "https://images.example/provider.jpg",
                        youtubeChannelId: "UC-provider",
                    },
                }),
            ),
        );
    };
    await render("Linkin Park");
    assert.match(
        container
            .querySelector("[data-image-src]")!
            .getAttribute("data-image-src")!,
        /native/,
    );
    await React.act(async () => imageError!());
    assert.match(
        container
            .querySelector("[data-image-src]")
            ?.getAttribute("data-image-src") ?? "",
        /provider/,
    );
    await React.act(async () => imageError!());
    assert.equal(container.querySelector("[data-image-src]"), null);
    await render("Linkin Park Tribute");
    assert.equal(container.querySelector("[data-image-src]"), null);
    await React.act(async () => root.unmount());
    container.remove();
});

test("canonical provider routing preserves the saved artist image when provider has none", async () => {
    const { SearchArtistsGrid } =
        await import("../../features/search/components/SearchArtistsGrid");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(
        React.createElement(SearchArtistsGrid, {
            libraryArtists: [
                {
                    id: "local",
                    name: "Кино",
                    heroUrl: "https://images.example/kino.jpg",
                },
            ],
            discoveryArtists: [
                { type: "music", name: "Кино", youtubeChannelId: "UC-kino" },
            ],
        }),
    );
    assert.match(html, /kino.jpg/);
    assert.match(html, /channelId=UC-kino/);
});
