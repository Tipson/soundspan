import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    pathname: "/library",
    isAuthenticated: true,
    hasActiveSessions: false,
    isMobile: false,
    isTablet: false,
    federation: false,
    likedTotal: 0,
    peerPlaylists: [] as Array<{
        remoteId: string;
        name: string;
        trackCount: number;
        updatedAt: string;
        owner: { displayName: string };
        peer: { id: string; name: string };
    }>,
};

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
        onClick?: React.MouseEventHandler<HTMLAnchorElement>;
    }) =>
        React.createElement(
            "a",
            {
                href,
                "data-has-on-click":
                    typeof rest.onClick === "function" ? "true" : undefined,
                ...rest,
            },
            children,
        ),
});

mock.module("next/image", {
    defaultExport: ({ src, alt, ...rest }: { src: string; alt: string }) =>
        React.createElement("img", { src, alt, ...rest }),
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
            getPlaylists: async () => [],
        },
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ isAuthenticated: state.isAuthenticated }),
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: null,
            currentAudiobook: null,
            currentPodcast: null,
            playbackType: "track",
        }),
    },
});

mock.module("@/hooks/useActiveListenSessions", {
    namedExports: {
        useActiveListenSessions: () => state.hasActiveSessions,
    },
});

mock.module("@/hooks/useQueries", {
    namedExports: {
        useLikedPlaylistQuery: () => ({
            data: { total: state.likedTotal, tracks: [] },
            isLoading: false,
            isError: false,
        }),
    },
});

mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useIsMobile: () => state.isMobile,
        useIsTablet: () => state.isTablet,
    },
});

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => ({ federation: state.federation }),
    },
});

mock.module("@/features/social/hooks/usePeerPlaylists", {
    namedExports: {
        usePeerPlaylists: () => ({
            playlists: state.peerPlaylists,
            peerErrors: [],
            enabled: state.federation,
        }),
    },
});

mock.module("@/components/ui/PeerBadge", {
    namedExports: {
        PeerBadge: ({ peerName }: { peerName: string }) =>
            React.createElement("span", null, `peer-badge:${peerName}`),
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

mock.module("../../components/layout/MobileSidebar.tsx", {
    namedExports: {
        MobileSidebar: () => React.createElement("div", null, "mobile-sidebar"),
    },
});

beforeEach(() => {
    state.pathname = "/library";
    state.isAuthenticated = true;
    state.hasActiveSessions = false;
    state.isMobile = false;
    state.isTablet = false;
    state.federation = false;
    state.likedTotal = 0;
    state.peerPlaylists = [];
});

test("returns null for auth routes", async () => {
    state.pathname = "/login";

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.equal(html, "");
});

test("keeps global search in the top bar instead of duplicating it in navigation", async () => {
    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.match(html, />Главная</);
    assert.doesNotMatch(html, />Search</);
    assert.doesNotMatch(html, /href="\/search"/);
    assert.match(html, />Коллекция</);
    assert.match(html, />Моя волна</);
    assert.doesNotMatch(html, />Explore</);
    assert.doesNotMatch(html, />Listen Together</);
    assert.doesNotMatch(html, />Audiobooks</);
    assert.doesNotMatch(html, />Podcasts</);
    assert.doesNotMatch(html, /My History/);
});

test("keeps prefetch enabled for primary sidebar navigation links", async () => {
    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    const navHrefs = ["/", "/vibe", "/library"];

    for (const href of navHrefs) {
        const escapedHref = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const linkMatch = html.match(
            new RegExp(`<a[^>]*href="${escapedHref}"[^>]*>`),
        );
        assert.ok(linkMatch, `Expected link for ${href}`);
        assert.doesNotMatch(
            linkMatch[0],
            /\sprefetch=/,
            `Primary nav link ${href} should not force prefetch off`,
        );
    }
});

test("desktop sidebar exposes a restrained shell landmark", async () => {
    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.match(html, /data-shell-sidebar="desktop"/);
    const sidebar = html.match(
        /<aside[^>]*data-shell-sidebar="desktop"[^>]*>/,
    )?.[0];
    assert.ok(sidebar);
    assert.match(sidebar, /w-\[224px\]/);
    assert.doesNotMatch(sidebar, /rounded-/);
    assert.match(html, /aria-label="Создать плейлист"/);
    assert.doesNotMatch(html, /Sync Library/);
});

test("desktop Library navigation can enter the precached Downloads shell offline", async () => {
    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    const libraryLink = html.match(/<a[^>]*href="\/library"[^>]*>/);
    assert.ok(libraryLink, "Expected desktop Library link");
    assert.match(libraryLink[0], /data-has-on-click="true"/);
});

test("renders badged peer playlists in the unified list when federated", async () => {
    state.federation = true;
    state.peerPlaylists = [
        {
            remoteId: "remote-1",
            name: "Peer Jams",
            trackCount: 4,
            updatedAt: "2026-08-20T00:00:00.000Z",
            owner: { displayName: "Sam" },
            peer: { id: "peer-a", name: "Family server" },
        },
    ];

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.match(html, /Peer Jams/);
    assert.match(html, /peer-badge:Family server/);
    assert.match(html, /href="\/peer-playlists\/peer-a\/remote-1"/);
    assert.match(html, /Автор: Sam/);
    assert.match(html, /4 трека/);
});

test("renders the pinned liked playlist and empty state in Russian", async () => {
    state.likedTotal = 21;

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.match(html, /Любимые треки/);
    assert.match(html, /Плейлист.*21 трек/);
    assert.match(html, /Плейлистов пока нет/);
    assert.match(html, /Создайте первый плейлист/);
    assert.doesNotMatch(html, /My Liked|No playlists yet/);
});

test("hides peer playlists without federation", async () => {
    state.federation = false;
    state.peerPlaylists = [
        {
            remoteId: "remote-1",
            name: "Peer Jams",
            trackCount: 4,
            updatedAt: "2026-08-20T00:00:00.000Z",
            owner: { displayName: "Sam" },
            peer: { id: "peer-a", name: "Family server" },
        },
    ];

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.doesNotMatch(html, /Peer Jams/);
    assert.doesNotMatch(html, /peer-badge:/);
});
