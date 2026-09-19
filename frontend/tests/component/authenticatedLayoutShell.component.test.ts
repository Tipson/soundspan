import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://soundspan.test/" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

const state = {
    isMobile: false,
    isTablet: false,
    ownerId: "listener-1",
    isAuthenticated: true,
};

const Marker = ({ name }: { name: string }) =>
    React.createElement("div", { "data-marker": name });

mock.module("next/navigation", {
    namedExports: {
        usePathname: () => "/",
        useSearchParams: () => new URLSearchParams(),
    },
});
mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({
            isAuthenticated: state.isAuthenticated,
            isLoading: false,
            user: { id: state.ownerId },
        }),
    },
});
mock.module("@/features/device-offline/components/DownloadsList", {
    namedExports: {
        DownloadsList: () =>
            React.createElement("p", null, `files:${state.ownerId}`),
    },
});
mock.module("@/features/taste-profile", {
    namedExports: {
        TasteProfileOnboardingGate: ({ accountId }: { accountId: string }) =>
            React.createElement("div", {
                "data-marker": "taste-profile-gate",
                "data-account-id": accountId,
            }),
    },
});
mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useIsMobile: () => state.isMobile,
        useIsTablet: () => state.isTablet,
    },
});
mock.module("@/lib/tv-utils", {
    namedExports: { useIsTV: () => false },
});
mock.module("@/hooks/useActivityPanel", {
    namedExports: {
        useActivityPanel: () => ({
            isOpen: false,
            activeTab: "notifications",
            toggle: () => undefined,
            open: () => undefined,
            close: () => undefined,
            setActiveTab: () => undefined,
        }),
    },
});
mock.module("@/hooks/usePresenceHeartbeat", {
    namedExports: { usePresenceHeartbeat: () => undefined },
});
mock.module("@/components/layout/Sidebar", {
    namedExports: {
        Sidebar: () => React.createElement(Marker, { name: "sidebar" }),
    },
});
mock.module("@/components/layout/TopBar", {
    namedExports: {
        TopBar: () => React.createElement(Marker, { name: "topbar" }),
    },
});
mock.module("@/components/layout/TVLayout", {
    namedExports: {
        TVLayout: ({ children }: { children: React.ReactNode }) => children,
    },
});
mock.module("@/components/layout/BottomNavigation", {
    namedExports: {
        BottomNavigation: () =>
            React.createElement(Marker, { name: "bottom-navigation" }),
    },
});
mock.module("@/components/player/UniversalPlayer", {
    namedExports: {
        UniversalPlayer: () => React.createElement(Marker, { name: "player" }),
    },
});
mock.module("@/components/player/MediaControlsHandler", {
    namedExports: { MediaControlsHandler: () => null },
});
mock.module("@/components/player/PlayerModeWrapper", {
    namedExports: {
        PlayerModeWrapper: ({ children }: { children: React.ReactNode }) =>
            children,
    },
});
mock.module("@/components/layout/ActivityPanel", {
    namedExports: { ActivityPanel: () => null },
});
mock.module("@/components/ui/GradientSpinner", {
    namedExports: { GradientSpinner: () => null },
});
mock.module("@/components/PWAInstallPrompt", {
    namedExports: { PWAInstallPrompt: () => null },
});
mock.module("@/components/ui/PullToRefresh", {
    namedExports: {
        PullToRefresh: ({ children }: { children: React.ReactNode }) =>
            children,
    },
});

beforeEach(() => {
    state.isMobile = false;
    state.isTablet = false;
    state.ownerId = "listener-1";
    state.isAuthenticated = true;
});

test("the shell retains its player while downloads open and closes them on account change or logout", async () => {
    state.isMobile = true;
    const { createRoot } = await import("react-dom/client");
    const { AuthenticatedLayout } =
        await import("../../components/layout/AuthenticatedLayout");
    const { openOfflineDownloads } =
        await import("../../components/layout/offlineLibraryNavigation");
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const root = createRoot(parent);
    const render = () =>
        React.act(async () =>
            root.render(
                React.createElement(AuthenticatedLayout, null, "music-content"),
            ),
        );
    try {
        await render();
        const player = parent.querySelector('[data-marker="player"]');
        await React.act(async () => openOfflineDownloads());
        assert.match(parent.textContent ?? "", /files:listener-1/);
        assert.equal(parent.querySelector('[data-marker="player"]'), player);
        state.ownerId = "listener-2";
        await render();
        assert.equal(parent.querySelector('[role="dialog"]'), null);
        await React.act(async () => openOfflineDownloads());
        assert.match(parent.textContent ?? "", /files:listener-2/);
        assert.doesNotMatch(parent.textContent ?? "", /files:listener-1/);
        state.isAuthenticated = false;
        await render();
        await React.act(async () => openOfflineDownloads());
        assert.equal(parent.querySelector('[role="dialog"]'), null);
    } finally {
        await React.act(async () => root.unmount());
        parent.remove();
    }
});

test("desktop shell keeps the sidebar full-height and the top bar inside the main column", async () => {
    const { AuthenticatedLayout } =
        await import("../../components/layout/AuthenticatedLayout");
    const html = renderToStaticMarkup(
        React.createElement(AuthenticatedLayout, null, "music-content"),
    );

    assert.match(html, /data-shell-frame="desktop"/);
    assert.match(html, /data-shell-direction="spectral-stage"/);
    assert.match(html, /data-shell-workspace="desktop"/);
    assert.match(html, /data-shell-main-column="desktop"/);
    assert.match(html, /data-shell-surface="content"/);
    assert.match(html, /data-shell-canvas="open"/);
    assert.doesNotMatch(html, /desktop-content-stage[^\"]*rounded-/);
    const sidebarIndex = html.indexOf('data-marker="sidebar"');
    const mainColumnIndex = html.indexOf('data-shell-main-column="desktop"');
    const topbarIndex = html.indexOf('data-marker="topbar"');
    const playerIndex = html.indexOf('data-marker="player"');
    assert.ok(sidebarIndex > -1);
    assert.ok(mainColumnIndex > sidebarIndex);
    assert.ok(topbarIndex > mainColumnIndex);
    assert.ok(playerIndex > topbarIndex);
    assert.match(html, /data-marker="sidebar"/);
    assert.match(html, /data-marker="player"/);
    assert.match(html, /data-marker="taste-profile-gate"/);
    assert.match(html, /data-account-id="listener-1"/);
    assert.match(html, /Перейти к основному содержимому/);
    assert.doesNotMatch(html, /galaxy-background/);
});

test("mobile shell keeps safe chrome around an unframed content canvas", async () => {
    state.isMobile = true;

    const { AuthenticatedLayout } =
        await import("../../components/layout/AuthenticatedLayout");
    const html = renderToStaticMarkup(
        React.createElement(AuthenticatedLayout, null, "music-content"),
    );

    assert.match(html, /data-shell-frame="mobile"/);
    assert.match(html, /data-shell-direction="spectral-stage"/);
    assert.match(html, /data-shell-surface="content"/);
    assert.match(html, /data-shell-canvas="open"/);
    assert.match(html, /data-marker="topbar"/);
    assert.match(html, /data-marker="player"/);
    assert.match(html, /data-marker="bottom-navigation"/);
    assert.equal(
        (html.match(/data-marker="taste-profile-gate"/g) ?? []).length,
        1,
    );
    assert.match(html, /mobile-app-stage/);
    assert.doesNotMatch(html, /mobile-app-stage[^\"]*rounded-/);
    assert.equal(
        (html.match(/data-shell-bottom-inset-owner=/g) ?? []).length,
        1,
    );
    const shellFrame = html.match(
        /<div[^>]*data-shell-frame="mobile"[^>]*>/,
    )?.[0];
    assert.ok(shellFrame);
    assert.match(shellFrame, /padding-bottom:0/);
    const contentInset = html.match(
        /<div[^>]*data-shell-bottom-inset-owner="content"[^>]*>/,
    )?.[0];
    assert.ok(contentInset);
    assert.match(
        contentInset,
        /padding-bottom:calc\(var\(--app-mini-player-height\) \+ var\(--app-bottom-nav-height\) \+ var\(--safe-area-bottom\) \+ 12px\)/,
    );
});

test("tablet shell reuses the single mobile bottom inset owner", async () => {
    state.isTablet = true;

    const { AuthenticatedLayout } =
        await import("../../components/layout/AuthenticatedLayout");
    const html = renderToStaticMarkup(
        React.createElement(AuthenticatedLayout, null, "music-content"),
    );

    assert.match(html, /data-shell-frame="mobile"/);
    assert.equal(
        (html.match(/data-shell-bottom-inset-owner=/g) ?? []).length,
        1,
    );
    assert.match(
        html,
        /padding-bottom:calc\(var\(--app-mini-player-height\) \+ var\(--app-bottom-nav-height\) \+ var\(--safe-area-bottom\) \+ 12px\)/,
    );
});
