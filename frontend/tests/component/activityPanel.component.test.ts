import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    userRole: "admin" as "admin" | "user",
    unreadCount: 0,
    downloads: [] as Array<{ id: string }>,
    socialUsers: [] as Array<{ id: string }>,
    isMobile: false,
    isTablet: false,
    notificationHookOptions: [] as Array<{ enabled?: boolean } | undefined>,
    activeDownloadsHookOptions: [] as Array<{ enabled?: boolean } | undefined>,
    socialPresenceHookOptions: [] as Array<{ enabled?: boolean } | undefined>,
};

const Icon = () => React.createElement("i");
const tab = (name: string) => {
    const MockTab = function MockTab() {
        return React.createElement("div", null, name);
    };
    MockTab.displayName = `Mock${name}`;
    return MockTab;
};

mock.module("@/hooks/useNotifications", {
    namedExports: {
        useNotifications: (options?: { enabled?: boolean }) => {
            state.notificationHookOptions.push(options);
            return {
                unreadCount: state.unreadCount,
                notifications: Array.from(
                    { length: state.unreadCount },
                    (_, index) => ({
                        id: `n-${index}`,
                        type: "import_complete",
                        title: "Import complete",
                        read: false,
                    }),
                ),
            };
        },
        useActiveDownloads: (options?: { enabled?: boolean }) => {
            state.activeDownloadsHookOptions.push(options);
            return { downloads: state.downloads };
        },
    },
});

mock.module("@/hooks/useSocialPresence", {
    namedExports: {
        useSocialPresence: (options?: { enabled?: boolean }) => {
            state.socialPresenceHookOptions.push(options);
            return { users: state.socialUsers };
        },
    },
});

mock.module("@/hooks/useActiveYouTubeDownloads", {
    namedExports: {
        useActiveYouTubeDownloads: () => ({
            jobs: [],
            activeCount: 0,
            isLoading: false,
            refetch: async () => undefined,
            cancel: () => undefined,
            cancelAll: () => undefined,
        }),
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ user: { role: state.userRole } }),
    },
});

mock.module("@/lib/download-context", {
    namedExports: {
        useDownloadContext: () => ({
            pendingDownloads: [],
            downloadStatus: {
                activeDownloads: state.downloads,
                recentDownloads: [],
                hasActiveDownloads: state.downloads.length > 0,
                failedDownloads: [],
            },
            downloadsEnabled: true,
        }),
    },
});

mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useIsMobile: () => state.isMobile,
        useIsTablet: () => state.isTablet,
    },
});

mock.module("@/components/activity/NotificationsTab", {
    namedExports: {
        NotificationsTab: tab("notifications-tab"),
    },
});

mock.module("@/components/activity/ActiveDownloadsTab", {
    namedExports: {
        ActiveDownloadsTab: tab("active-tab"),
    },
});

mock.module("@/components/activity/HistoryTab", {
    namedExports: {
        HistoryTab: tab("history-tab"),
    },
});

mock.module("@/components/activity/SocialTab", {
    namedExports: {
        SocialTab: tab("social-tab"),
    },
});

mock.module("@/components/activity/ImportsTab", {
    namedExports: {
        ImportsTab: tab("imports-tab"),
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("lucide-react", {
    namedExports: {
        Bell: Icon,
        Download: Icon,
        FileInput: Icon,
        History: Icon,
        Users: Icon,
        ChevronLeft: Icon,
        ChevronRight: Icon,
        X: Icon,
    },
});

beforeEach(() => {
    state.userRole = "admin";
    state.unreadCount = 0;
    state.downloads = [];
    state.socialUsers = [];
    state.isMobile = false;
    state.isTablet = false;
    state.notificationHookOptions = [];
    state.activeDownloadsHookOptions = [];
    state.socialPresenceHookOptions = [];
});

test("shows all tabs for admin users on desktop", async () => {
    state.unreadCount = 3;
    state.downloads = [{ id: "d1" }];
    state.socialUsers = [{ id: "u1" }];

    const { ActivityPanel } =
        await import("../../components/layout/ActivityPanel");

    const html = renderToStaticMarkup(
        React.createElement(ActivityPanel, {
            isOpen: true,
            onToggle: () => undefined,
        }),
    );

    assert.match(html, />Уведомления</);
    assert.match(html, />Активные</);
    assert.match(html, />История</);
    assert.match(html, />Импорт</);
    assert.match(html, />Сейчас онлайн</);
    assert.match(html, /notifications-tab/);
    assert.equal(
        state.notificationHookOptions.some(
            (options) => options?.enabled === true,
        ),
        true,
    );
    assert.equal(
        state.socialPresenceHookOptions.some(
            (options) => options?.enabled === true,
        ),
        true,
    );
});

test("keeps ordinary-user activity focused on notifications and imports", async () => {
    state.userRole = "user";
    state.socialUsers = [{ id: "u1" }];

    const { ActivityPanel } =
        await import("../../components/layout/ActivityPanel");

    const html = renderToStaticMarkup(
        React.createElement(ActivityPanel, {
            isOpen: true,
            onToggle: () => undefined,
            activeTab: "active",
        }),
    );

    assert.match(html, />Уведомления</);
    assert.match(html, />Импорт</);
    assert.doesNotMatch(html, />Сейчас онлайн</);
    assert.doesNotMatch(html, />Активные</);
    assert.doesNotMatch(html, />История</);
    assert.match(html, /notifications-tab/);
});

test("renders mobile overlay with social content and capped badges", async () => {
    state.isMobile = true;
    state.unreadCount = 120;
    state.downloads = Array.from({ length: 101 }, (_, index) => ({
        id: `d-${index}`,
    }));
    state.socialUsers = Array.from({ length: 101 }, (_, index) => ({
        id: `u-${index}`,
    }));

    const { ActivityPanel } =
        await import("../../components/layout/ActivityPanel");

    const html = renderToStaticMarkup(
        React.createElement(ActivityPanel, {
            isOpen: true,
            onToggle: () => undefined,
            activeTab: "social",
        }),
    );

    assert.match(html, /title="Закрыть панель активности"/);
    assert.match(html, /social-tab/);
    assert.match(html, /99\+/);
});

test("renders controlled active, history, imports, and social content", async () => {
    const { ActivityPanel } =
        await import("../../components/layout/ActivityPanel");

    const tabCases: Array<
        [string, "active" | "history" | "imports" | "social"]
    > = [
        ["active-tab", "active"],
        ["history-tab", "history"],
        ["imports-tab", "imports"],
        ["social-tab", "social"],
    ];

    for (const [expectedMarkup, activeTab] of tabCases) {
        const html = renderToStaticMarkup(
            React.createElement(ActivityPanel, {
                isOpen: true,
                onToggle: () => undefined,
                activeTab,
            }),
        );

        assert.match(html, new RegExp(expectedMarkup));
    }
});

test("returns null for closed mobile panel", async () => {
    state.isMobile = true;

    const { ActivityPanel } =
        await import("../../components/layout/ActivityPanel");

    const html = renderToStaticMarkup(
        React.createElement(ActivityPanel, {
            isOpen: false,
            onToggle: () => undefined,
        }),
    );

    assert.equal(html, "");
});

test("closed desktop activity does not reserve a permanent sidebar strip", async () => {
    const { ActivityPanel } =
        await import("../../components/layout/ActivityPanel");

    const html = renderToStaticMarkup(
        React.createElement(ActivityPanel, {
            isOpen: false,
            onToggle: () => undefined,
        }),
    );

    assert.equal(html, "");
    assert.equal(
        state.notificationHookOptions.some(
            (options) => options?.enabled === false,
        ),
        true,
    );
    assert.equal(
        state.socialPresenceHookOptions.some(
            (options) => options?.enabled === false,
        ),
        true,
    );
});

test("open desktop activity overlays content instead of shrinking it", async () => {
    const { ActivityPanel } =
        await import("../../components/layout/ActivityPanel");

    const html = renderToStaticMarkup(
        React.createElement(ActivityPanel, {
            isOpen: true,
            onToggle: () => undefined,
        }),
    );

    assert.match(html, /data-activity-panel-layout="overlay"/);
    assert.doesNotMatch(html, /Открыть панель активности/);
});

test("activity panel toggle hides on mobile and renders on desktop", async () => {
    const { ActivityPanelToggle } =
        await import("../../components/layout/ActivityPanel");

    state.isMobile = true;
    let html = renderToStaticMarkup(React.createElement(ActivityPanelToggle));
    assert.equal(html, "");

    state.isMobile = false;
    state.unreadCount = 1;
    html = renderToStaticMarkup(React.createElement(ActivityPanelToggle));
    assert.match(html, /Открыть или закрыть панель активности/);
    assert.match(html, /w-1 h-1 rounded-full/);
});

test("activity panel toggle omits badge when idle", async () => {
    const { ActivityPanelToggle } =
        await import("../../components/layout/ActivityPanel");

    const html = renderToStaticMarkup(React.createElement(ActivityPanelToggle));
    assert.doesNotMatch(html, /w-1 h-1 rounded-full/);
});

test("activity panel toggle can disable polling when panel is open", async () => {
    const { ActivityPanelToggle } =
        await import("../../components/layout/ActivityPanel");

    renderToStaticMarkup(
        React.createElement<{ pollingEnabled?: boolean }>(ActivityPanelToggle, {
            pollingEnabled: false,
        }),
    );

    assert.equal(
        state.notificationHookOptions.some(
            (options) => options?.enabled === false,
        ),
        true,
    );
});
