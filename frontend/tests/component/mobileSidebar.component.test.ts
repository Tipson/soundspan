import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state: {
    pathname: string;
    hasActiveSessions: boolean;
    user: { id: string; role: string } | undefined;
} = {
    pathname: "/discover",
    hasActiveSessions: false,
    user: undefined,
};

const Icon = () => React.createElement("i");

mock.module("next/navigation", {
    namedExports: {
        usePathname: () => state.pathname,
    },
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
            logout: async () => undefined,
        }),
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                error: () => undefined,
                success: () => undefined,
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
    state.hasActiveSessions = false;
    state.user = undefined;
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

test("keeps search in the top bar and moves notifications into the account drawer", async () => {
    const { MobileSidebar } =
        await import("../../components/layout/MobileSidebar");

    const html = renderToStaticMarkup(
        React.createElement(MobileSidebar, {
            isOpen: true,
            onClose: () => undefined,
            hasActiveSessions: state.hasActiveSessions,
        }),
    );

    assert.match(html, />Listen</);
    assert.match(html, />Главная</);
    assert.doesNotMatch(html, />Поиск</);
    assert.doesNotMatch(html, /href="\/search"/);
    assert.match(html, />Коллекция</);
    assert.match(html, />Моя волна</);
    assert.match(html, />Любимые треки</);
    assert.match(html, />Загрузки</);
    assert.match(html, />Импорт плейлиста</);
    const notifications = html.match(
        /<button[^>]*aria-label="Открыть уведомления"[^>]*>/,
    )?.[0];
    assert.ok(notifications);
    assert.match(notifications, /min-h-11/);
    assert.doesNotMatch(html, />Обзор</);
    assert.doesNotMatch(html, />Совместное прослушивание</);
    assert.doesNotMatch(html, /Моя история/);
});

test("marks Vibe as current without exposing a social quick link", async () => {
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

    assert.match(html, /href="\/vibe"/);
    assert.match(html, /aria-current="page"/);
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
