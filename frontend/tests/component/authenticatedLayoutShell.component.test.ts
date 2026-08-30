import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    isMobile: false,
    isTablet: false,
};

const Marker = ({ name }: { name: string }) =>
    React.createElement("div", { "data-marker": name });

mock.module("next/navigation", {
    namedExports: { usePathname: () => "/" },
});
mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({
            isAuthenticated: true,
            isLoading: false,
            user: { id: "listener-1" },
        }),
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
});

test("desktop shell exposes one open canvas instead of a framed content card", async () => {
    const { AuthenticatedLayout } =
        await import("../../components/layout/AuthenticatedLayout");
    const html = renderToStaticMarkup(
        React.createElement(AuthenticatedLayout, null, "music-content"),
    );

    assert.match(html, /data-shell-frame="desktop"/);
    assert.match(html, /data-shell-workspace="desktop"/);
    assert.match(html, /data-shell-surface="content"/);
    assert.match(html, /data-shell-canvas="open"/);
    assert.match(html, /desktop-shell-workspace[^\"]*gap-0/);
    assert.doesNotMatch(html, /desktop-content-stage[^\"]*rounded-/);
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
});
