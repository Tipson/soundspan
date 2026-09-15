import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://soundspan.test/" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

let ownerId = "owner-a";
mock.module("@/features/device-offline/components/DownloadsList", {
    namedExports: {
        DownloadsList: () =>
            React.createElement("p", null, `local-files:${ownerId}`),
    },
});
mock.module("next/navigation", {
    namedExports: { usePathname: () => window.location.pathname },
});
mock.module("next/link", {
    defaultExport: ({ children, ...props }: React.ComponentProps<"a">) =>
        React.createElement("a", props, children),
});
mock.module("@/hooks/useMediaQuery", {
    namedExports: { useIsMobile: () => true, useIsTablet: () => false },
});

test("downloads open locally from home and search with a live player, even when online lies", async () => {
    const { createRoot } = await import("react-dom/client");
    const { OfflineDownloadsPanel } =
        await import("../../components/layout/OfflineDownloadsPanel");
    const { BottomNavigation } =
        await import("../../components/layout/BottomNavigation");
    const { openOfflineDownloads } =
        await import("../../components/layout/offlineLibraryNavigation");
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const root = createRoot(parent);
    const fetchSpy = mock.method(
        globalThis,
        "fetch",
        () => new Promise<Response>(() => {}),
    );
    try {
        for (const path of ["/", "/search?q=test"]) {
            window.history.replaceState(null, "", path);
            await React.act(async () =>
                root.render(
                    React.createElement(
                        React.Fragment,
                        null,
                        React.createElement("audio", { "data-player": "live" }),
                        React.createElement("main", null, `route:${path}`),
                        React.createElement(BottomNavigation),
                        React.createElement(OfflineDownloadsPanel, {
                            key: ownerId,
                        }),
                    ),
                ),
            );
            const audio = parent.querySelector("audio");
            const downloadButton = parent.querySelector<HTMLButtonElement>(
                'button[aria-haspopup="dialog"]',
            );
            assert.ok(downloadButton);
            assert.equal(
                parent.querySelectorAll("nav a, nav button").length,
                4,
            );
            await React.act(async () => downloadButton.click());
            assert.ok(parent.querySelector('[role="dialog"]'));
            assert.match(parent.textContent ?? "", /local-files:owner-a/);
            assert.equal(parent.querySelector("audio"), audio);
            assert.equal(
                window.location.pathname + window.location.search,
                path,
            );
            assert.equal(fetchSpy.mock.callCount(), 0);
            await React.act(async () =>
                window.dispatchEvent(
                    new KeyboardEvent("keydown", {
                        key: "Escape",
                        bubbles: true,
                    }),
                ),
            );
            assert.equal(parent.querySelector('[role="dialog"]'), null);
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        await React.act(async () => openOfflineDownloads());
        await React.act(async () => {
            window.history.back();
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
        assert.equal(parent.querySelector('[role="dialog"]'), null);
        assert.equal(window.location.pathname, "/search");

        await React.act(async () => openOfflineDownloads());
        ownerId = "owner-b";
        await React.act(async () =>
            root.render(
                React.createElement(OfflineDownloadsPanel, { key: ownerId }),
            ),
        );
        assert.equal(parent.querySelector('[role="dialog"]'), null);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await React.act(async () => openOfflineDownloads());
        assert.match(parent.textContent ?? "", /local-files:owner-b/);
        assert.doesNotMatch(parent.textContent ?? "", /local-files:owner-a/);
        await React.act(async () => root.render(null));
        await React.act(async () => openOfflineDownloads());
        assert.equal(parent.querySelector('[role="dialog"]'), null);
    } finally {
        await React.act(async () => root.unmount());
        mock.restoreAll();
        parent.remove();
    }
});
