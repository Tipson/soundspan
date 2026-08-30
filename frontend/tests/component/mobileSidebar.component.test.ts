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

test("renders the focused music quick links and omits secondary routes", async () => {
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
    assert.match(html, />Home</);
    assert.match(html, />Search</);
    assert.match(html, />Library</);
    assert.match(html, />Vibe</);
    assert.match(html, />Liked songs</);
    assert.match(html, />Downloads</);
    assert.match(html, />Import playlist</);
    assert.doesNotMatch(html, />Explore</);
    assert.doesNotMatch(html, />Listen Together</);
    assert.doesNotMatch(html, /My History/);
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
    assert.doesNotMatch(html, /eq-bars|Listen Together/);
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
    assert.match(adminHtml, />Requests</);
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
