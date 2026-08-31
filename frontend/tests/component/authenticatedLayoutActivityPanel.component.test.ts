import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://soundspan.test/" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("next/navigation", {
    namedExports: { usePathname: () => "/" },
});
mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({
            isAuthenticated: true,
            isLoading: false,
            user: { id: "listener-1", role: "user" },
        }),
    },
});
mock.module("@/features/taste-profile", {
    namedExports: { TasteProfileOnboardingGate: () => null },
});
mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useIsMobile: () => false,
        useIsTablet: () => false,
    },
});
mock.module("@/lib/tv-utils", {
    namedExports: { useIsTV: () => false },
});
mock.module("@/hooks/usePresenceHeartbeat", {
    namedExports: { usePresenceHeartbeat: () => undefined },
});
mock.module("@/components/layout/Sidebar", {
    namedExports: { Sidebar: () => null },
});
mock.module("@/components/layout/TopBar", {
    namedExports: {
        TopBar: ({
            onActivityPanelToggle,
        }: {
            onActivityPanelToggle?: () => void;
        }) =>
            React.createElement(
                "button",
                {
                    type: "button",
                    onClick: onActivityPanelToggle,
                    "aria-label": "Toggle activity panel",
                },
                "Activity",
            ),
    },
});
mock.module("@/components/layout/TVLayout", {
    namedExports: {
        TVLayout: ({ children }: { children: React.ReactNode }) => children,
    },
});
mock.module("@/components/layout/BottomNavigation", {
    namedExports: { BottomNavigation: () => null },
});
mock.module("@/components/player/UniversalPlayer", {
    namedExports: { UniversalPlayer: () => null },
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
    namedExports: {
        ActivityPanel: ({ isOpen }: { isOpen: boolean }) =>
            isOpen
                ? React.createElement("aside", {
                      "data-testid": "activity-panel",
                  })
                : null,
    },
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

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    document.body.replaceChildren();
});

test("desktop top bar toggles activity directly without waiting for a window event bridge", async () => {
    const { AuthenticatedLayout } =
        await import("../../components/layout/AuthenticatedLayout");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(
                AuthenticatedLayout,
                null,
                React.createElement("div", null, "music"),
            ),
        );
    });

    const toggle = container.querySelector(
        'button[aria-label="Toggle activity panel"]',
    );
    assert.ok(toggle instanceof HTMLButtonElement);
    assert.equal(
        container.querySelector('[data-testid="activity-panel"]'),
        null,
    );

    await React.act(async () => toggle.click());

    assert.ok(container.querySelector('[data-testid="activity-panel"]'));
    await React.act(async () => root.unmount());
    container.remove();
});
