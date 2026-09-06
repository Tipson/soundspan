import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());
mock.module("next/link", {
    defaultExport: React.forwardRef<
        HTMLAnchorElement,
        React.ComponentProps<"a">
    >(function Link(props, ref) {
        return React.createElement("a", { ...props, ref });
    }),
});

async function mount() {
    const { createRoot } = await import("react-dom/client");
    const { LibraryTabs } =
        await import("../../features/library/components/LibraryTabs");
    const parent = document.createElement("main");
    document.body.appendChild(parent);
    const root = createRoot(parent);
    const render = async (activeTab: "playlists" | "albums" | "artists") => {
        await React.act(async () =>
            root.render(React.createElement(LibraryTabs, { activeTab })),
        );
    };
    await render("playlists");
    const artist = parent.querySelector<HTMLAnchorElement>(
        'a[href="/library?tab=artists"]',
    );
    assert.ok(artist);
    const strip = artist.parentElement;
    assert.ok(strip);
    parent.scrollTop = 650;
    strip.scrollLeft = 100;
    const intoView = mock.method(artist, "scrollIntoView", () => {
        parent.scrollTop = 0;
    });
    mock.method(
        strip,
        "getBoundingClientRect",
        () => new DOMRect(20, -650, 260, 44),
    );
    return {
        parent,
        strip,
        artist,
        intoView,
        render,
        async close() {
            await React.act(async () => root.unmount());
            mock.restoreAll();
            parent.remove();
        },
    };
}

for (const [name, left, width, expected] of [
    ["right-clipped mobile tab", 250, 120, 190],
    ["left-clipped mobile tab", -30, 120, 50],
    ["fully visible desktop tab", 80, 120, 100],
] as const) {
    test(`reveals ${name} without moving the page`, async () => {
        const view = await mount();
        try {
            mock.method(
                view.artist,
                "getBoundingClientRect",
                () => new DOMRect(left, -650, width, 44),
            );
            await view.render("artists");
            assert.equal(view.parent.scrollTop, 650);
            assert.equal(view.strip.scrollLeft, expected);
            assert.equal(view.intoView.mock.callCount(), 0);
            assert.equal(view.artist.getAttribute("aria-current"), "page");
        } finally {
            await view.close();
        }
    });
}

test("background rerender preserves manual horizontal and vertical browsing", async () => {
    const view = await mount();
    try {
        mock.method(
            view.artist,
            "getBoundingClientRect",
            () => new DOMRect(250, -650, 120, 44),
        );
        await view.render("artists");
        view.parent.scrollTop = 800;
        view.strip.scrollLeft = 15;
        await view.render("artists");
        assert.equal(view.parent.scrollTop, 800);
        assert.equal(view.strip.scrollLeft, 15);
    } finally {
        await view.close();
    }
});
