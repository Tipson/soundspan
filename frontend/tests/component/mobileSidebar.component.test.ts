import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

test("mobile drawer keeps keyboard focus inside and restores its opener", async () => {
    const { MobileSidebar } =
        await import("../../components/layout/MobileSidebar");
    const { createRoot } = await import("react-dom/client");
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await React.act(async () =>
            root.render(
                React.createElement(MobileSidebar, {
                    isOpen: true,
                    onClose: () => undefined,
                    hasActiveSessions: false,
                }),
            ),
        );
        const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
        assert.ok(dialog);
        assert.ok(
            dialog.contains(document.activeElement),
            "focus must move inside the drawer",
        );
        const items = dialog.querySelectorAll<HTMLElement>(
            "a,button:not([disabled])",
        );
        const last = items[items.length - 1];
        last.focus();
        await React.act(async () =>
            last.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "Tab",
                    bubbles: true,
                    cancelable: true,
                }),
            ),
        );
        assert.ok(
            document.activeElement === items[0],
            "Tab at the last action must wrap inside the drawer",
        );
        await React.act(async () =>
            root.render(
                React.createElement(MobileSidebar, {
                    isOpen: false,
                    onClose: () => undefined,
                    hasActiveSessions: false,
                }),
            ),
        );
        assert.ok(document.activeElement === opener);
    } finally {
        await React.act(async () => root.unmount());
        opener.remove();
        container.remove();
    }
});

test("mobile install action closes the drawer and requests the existing installation UI", async () => {
    const { MobileSidebar } =
        await import("../../components/layout/MobileSidebar");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const calls: string[] = [];
    const request = () => calls.push("install");
    window.addEventListener("request-pwa-install", request);
    try {
        await React.act(async () =>
            root.render(
                React.createElement(MobileSidebar, {
                    isOpen: true,
                    onClose: () => calls.push("close"),
                    hasActiveSessions: false,
                }),
            ),
        );
        calls.length = 0;
        const button = Array.from(container.querySelectorAll("button")).find(
            (item) => item.textContent?.includes("Установить приложение"),
        );
        assert.ok(
            button,
            "installation must be reachable from mobile navigation",
        );
        await React.act(async () => button.click());
        assert.deepEqual(calls, ["close", "install"]);
    } finally {
        window.removeEventListener("request-pwa-install", request);
        await React.act(async () => root.unmount());
        container.remove();
    }
});

const state: {
    pathname: string;
    query: string;
    standalone: boolean;
    hasActiveSessions: boolean;
    logoutError: Error | null;
    user: { id: string; role: string } | undefined;
} = {
    pathname: "/discover",
    query: "",
    standalone: false,
    hasActiveSessions: false,
    logoutError: null,
    user: undefined,
};

const Icon = () => React.createElement("i");

mock.module("next/navigation", {
    namedExports: {
        usePathname: () => state.pathname,
        useSearchParams: () => new URLSearchParams(state.query),
    },
});

mock.module("@/hooks/useMediaQuery", {
    namedExports: { useMediaQuery: () => state.standalone },
});

mock.module("next/link", {
    defaultExport: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    }) => React.createElement("a", { href, ...rest }, children),
});

mock.module("next/image", {
    defaultExport: ({ src, alt, ...rest }: { src: string; alt: string }) =>
        React.createElement("img", { src, alt, ...rest }),
});

mock.module("lucide-react", {
    namedExports: {
        Settings: Icon,
        LogOut: Icon,
        Search: Icon,
        Home: Icon,
        Library: Icon,
        AudioWaveform: Icon,
        ListMusic: Icon,
        Upload: Icon,
        Download: Icon,
        Heart: Icon,
        X: Icon,
        Inbox: Icon,
        Shield: Icon,
        Bell: Icon,
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            scanLibrary: async () => undefined,
        },
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({
            user: state.user,
            logout: async () => {
                if (state.logoutError) throw state.logoutError;
            },
        }),
    },
});

mock.module("@/lib/logger", {
    namedExports: { frontendLogger: { error: () => undefined } },
});

const toastMessages = { success: [] as string[], error: [] as string[] };

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                error: (message: string) => toastMessages.error.push(message),
                success: (message: string) =>
                    toastMessages.success.push(message),
            },
        }),
    },
});

mock.module("@/components/ui/EqBars", {
    namedExports: {
        EqBars: () => React.createElement("span", null, "eq-bars"),
    },
});

beforeEach(() => {
    state.pathname = "/discover";
    state.query = "";
    state.standalone = false;
    state.hasActiveSessions = false;
    state.logoutError = null;
    state.user = undefined;
    toastMessages.success.length = 0;
    toastMessages.error.length = 0;
});

test("returns null when closed", async () => {
    const { MobileSidebar } =
        await import("../../components/layout/MobileSidebar");

    const html = renderToStaticMarkup(
        React.createElement(MobileSidebar, {
            isOpen: false,
            onClose: () => undefined,
            hasActiveSessions: false,
        }),
    );

    assert.equal(html, "");
});

test("keeps primary navigation outside the account drawer", async () => {
    const { MobileSidebar } =
        await import("../../components/layout/MobileSidebar");

    const html = renderToStaticMarkup(
        React.createElement(MobileSidebar, {
            isOpen: true,
            onClose: () => undefined,
            hasActiveSessions: state.hasActiveSessions,
        }),
    );

    assert.match(html, /data-shell-drawer="account"/);
    assert.doesNotMatch(html, />Слушать</);
    assert.doesNotMatch(html, />Главная</);
    assert.doesNotMatch(html, />Поиск</);
    assert.doesNotMatch(html, /href="\/search"/);
    assert.doesNotMatch(html, />Коллекция</);
    assert.doesNotMatch(html, />Моя волна</);
    assert.match(html, />Любимые треки</);
    assert.match(html, /href="\/library"/);
    assert.doesNotMatch(html, /href="\/playlists"/);
    assert.match(html, />Загрузки</);
    assert.match(html, />Импорт плейлиста</);
    assert.match(html, />Ваша музыка</);
    assert.match(html, />Аккаунт</);
    assert.doesNotMatch(html, />Listen|Your music</);
    const notifications = html.match(
        /<button[^>]*aria-label="Открыть уведомления"[^>]*>/,
    )?.[0];
    assert.ok(notifications);
    assert.match(notifications, /min-h-12/);
    assert.doesNotMatch(html, />Обзор</);
    assert.doesNotMatch(html, />Совместное прослушивание</);
    assert.doesNotMatch(html, /Моя история/);
});

test("does not duplicate Vibe inside the account drawer", async () => {
    state.pathname = "/vibe";

    const { MobileSidebar } =
        await import("../../components/layout/MobileSidebar");

    const html = renderToStaticMarkup(
        React.createElement(MobileSidebar, {
            isOpen: true,
            onClose: () => undefined,
            hasActiveSessions: state.hasActiveSessions,
        }),
    );

    assert.doesNotMatch(html, /href="\/vibe"/);
    assert.doesNotMatch(html, />Моя волна</);
    assert.doesNotMatch(html, /eq-bars|Совместное прослушивание/);
});

test("admins see Requests and Admin links; users see neither", async () => {
    const { MobileSidebar } =
        await import("../../components/layout/MobileSidebar");

    state.user = { id: "u1", role: "user" };
    const userHtml = renderToStaticMarkup(
        React.createElement(MobileSidebar, {
            isOpen: true,
            onClose: () => undefined,
            hasActiveSessions: false,
        }),
    );
    assert.doesNotMatch(userHtml, /href="\/requests"/);
    assert.doesNotMatch(userHtml, /href="\/admin"/);

    state.user = { id: "a1", role: "admin" };
    const adminHtml = renderToStaticMarkup(
        React.createElement(MobileSidebar, {
            isOpen: true,
            onClose: () => undefined,
            hasActiveSessions: false,
        }),
    );
    assert.match(adminHtml, /href="\/requests"/);
    assert.match(adminHtml, />Запросы</);
    assert.match(adminHtml, /href="\/admin"/);
});

test("marks settings as the current route when viewing settings", async () => {
    state.pathname = "/settings";

    const { MobileSidebar } =
        await import("../../components/layout/MobileSidebar");

    const html = renderToStaticMarkup(
        React.createElement(MobileSidebar, {
            isOpen: true,
            onClose: () => undefined,
            hasActiveSessions: state.hasActiveSessions,
        }),
    );

    assert.match(html, /href="\/settings"/);
    assert.match(html, /aria-current="page"/);
});

test("only downloads is active on the downloads tab and installed PWA hides install", async () => {
    state.pathname = "/library";
    state.query = "tab=downloads";
    state.standalone = true;
    const { MobileSidebar } =
        await import("../../components/layout/MobileSidebar");
    const html = renderToStaticMarkup(
        React.createElement(MobileSidebar, {
            isOpen: true,
            onClose: () => undefined,
            hasActiveSessions: false,
        }),
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    assert.deepEqual(
        [...container.querySelectorAll('[aria-current="page"]')].map((e) =>
            e.getAttribute("href"),
        ),
        ["/library?tab=downloads"],
    );
    assert.doesNotMatch(html, /Установить приложение/);
});

test("changing only the Library tab closes the mobile drawer", async () => {
    state.pathname = "/library";
    const { MobileSidebar } =
        await import("../../components/layout/MobileSidebar");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let closes = 0;
    const onClose = () => {
        closes++;
    };
    const tree = () =>
        React.createElement(MobileSidebar, {
            isOpen: true,
            onClose,
            hasActiveSessions: false,
        });
    try {
        await React.act(async () => root.render(tree()));
        closes = 0;
        state.query = "tab=downloads";
        await React.act(async () => root.render(tree()));
        assert.equal(closes, 1);
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});

test("closing the mobile drawer through its backdrop restores the opener", async () => {
    const { MobileSidebar } =
        await import("../../components/layout/MobileSidebar");
    const { ru } = await import("../../lib/i18n/ru");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let closes = 0;
    function Harness() {
        const [open, setOpen] = React.useState(false);
        return React.createElement(
            React.Fragment,
            null,
            React.createElement(
                "button",
                { onClick: () => setOpen(true) },
                "Open drawer",
            ),
            React.createElement(MobileSidebar, {
                isOpen: open,
                hasActiveSessions: false,
                onClose: () => {
                    closes++;
                    setOpen(false);
                },
            }),
        );
    }
    try {
        await React.act(async () => root.render(React.createElement(Harness)));
        closes = 0;
        const opener = container.querySelector<HTMLButtonElement>("button");
        assert.ok(opener);
        opener.focus();
        await React.act(async () => opener.click());
        assert.ok(container.querySelector('[role="dialog"]'));
        const backdrop = [...container.querySelectorAll("button")].find(
            (button) =>
                button.getAttribute("aria-label") === ru.nav.closeMenuBackdrop,
        );
        assert.ok(backdrop, "a named backdrop action must remain available");
        await React.act(async () => backdrop.click());
        assert.equal(closes, 1);
        assert.equal(container.querySelector('[role="dialog"]'), null);
        assert.ok(
            document.activeElement === opener,
            "dismissal must return keyboard focus to the opener",
        );
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});

async function mountControlledDrawer() {
    const { MobileSidebar } =
        await import("../../components/layout/MobileSidebar");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const events: string[] = [];
    function Harness() {
        const [open, setOpen] = React.useState(false);
        return React.createElement(
            React.Fragment,
            null,
            React.createElement(
                "button",
                { onClick: () => setOpen(true) },
                "Open drawer",
            ),
            React.createElement(MobileSidebar, {
                isOpen: open,
                hasActiveSessions: false,
                onClose: () => {
                    events.push("close");
                    setOpen(false);
                },
            }),
        );
    }
    await React.act(async () => root.render(React.createElement(Harness)));
    const opener = container.querySelector<HTMLButtonElement>("button");
    assert.ok(opener);
    opener.focus();
    await React.act(async () => opener.click());
    events.length = 0;
    return {
        container,
        opener,
        events,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("notifications dismiss the drawer before requesting the activity panel", async () => {
    const { ru } = await import("../../lib/i18n/ru");
    const mounted = await mountControlledDrawer();
    const onOpenActivity = () => mounted.events.push("activity");
    window.addEventListener("open-activity-panel", onOpenActivity);
    try {
        const notifications =
            mounted.container.querySelector<HTMLButtonElement>(
                'button[aria-label="' + ru.nav.openNotifications + '"]',
            );
        assert.ok(notifications);
        await React.act(async () => notifications.click());
        assert.deepEqual(mounted.events, ["close", "activity"]);
        assert.equal(mounted.container.querySelector('[role="dialog"]'), null);
        assert.ok(document.activeElement === mounted.opener);
    } finally {
        window.removeEventListener("open-activity-panel", onOpenActivity);
        await mounted.unmount();
    }
});

test("logout failure keeps the drawer open until a successful retry", async () => {
    const { ru } = await import("../../lib/i18n/ru");
    const mounted = await mountControlledDrawer();
    try {
        const logout = [...mounted.container.querySelectorAll("button")].find(
            (button) => button.textContent?.includes(ru.nav.logout),
        );
        assert.ok(logout);
        state.logoutError = new Error("fixture logout failure");
        await React.act(async () => {
            logout.click();
            await Promise.resolve();
        });
        assert.deepEqual(mounted.events, []);
        assert.ok(mounted.container.querySelector('[role="dialog"]'));
        assert.deepEqual(toastMessages.error, [ru.nav.logoutFailed]);
        assert.deepEqual(toastMessages.success, []);

        state.logoutError = null;
        await React.act(async () => {
            logout.click();
            await Promise.resolve();
        });
        assert.deepEqual(mounted.events, ["close"]);
        assert.equal(mounted.container.querySelector('[role="dialog"]'), null);
        assert.deepEqual(toastMessages.success, [ru.nav.logoutSuccess]);
        assert.ok(document.activeElement === mounted.opener);
    } finally {
        state.logoutError = null;
        await mounted.unmount();
    }
});
