import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

GlobalRegistrator.register({ url: "https://soundspan.test/library" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let queryClient = new QueryClient();

const state = {
    pathname: "/library",
    isAuthenticated: true,
    hasActiveSessions: false,
    isMobile: false,
    isTablet: false,
    isShortDesktop: false,
    federation: false,
    likedTotal: 0,
    likedQueryCalls: 0,
    playlistQueryCalls: 0,
    playlistRefetchCalls: 0,
    playlistsLoading: false,
    playlistsError: false,
    invalidatedQueries: [] as unknown[],
    playlists: [] as Array<{
        id: string;
        name: string;
        trackCount?: number;
        isHidden?: boolean;
        isOwner?: boolean;
    }>,
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
        queryKeys: { playlists: () => ["playlists"] },
        useLikedPlaylistQuery: () => {
            state.likedQueryCalls += 1;
            return {
                data: { total: state.likedTotal, tracks: [] },
                isLoading: false,
                isError: false,
            };
        },
        usePlaylistsQuery: () => {
            state.playlistQueryCalls += 1;
            return {
                data: state.playlists,
                isLoading: state.playlistsLoading,
                isError: state.playlistsError,
                refetch: async () => {
                    state.playlistRefetchCalls += 1;
                },
            };
        },
    },
});

mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useIsMobile: () => state.isMobile,
        useIsTablet: () => state.isTablet,
        useMediaQuery: (query: string) =>
            query === "(max-height: 850px)" && state.isShortDesktop,
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

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    state.pathname = "/library";
    state.isAuthenticated = true;
    state.hasActiveSessions = false;
    state.isMobile = false;
    state.isTablet = false;
    state.isShortDesktop = false;
    state.federation = false;
    state.likedTotal = 0;
    state.likedQueryCalls = 0;
    state.playlistQueryCalls = 0;
    state.playlistRefetchCalls = 0;
    state.playlistsLoading = false;
    state.playlistsError = false;
    state.invalidatedQueries = [];
    state.playlists = [];
    state.peerPlaylists = [];
    queryClient = new QueryClient();
    queryClient.invalidateQueries = (async (filters: unknown) => {
        state.invalidatedQueries.push(filters);
    }) as typeof queryClient.invalidateQueries;
    document.body.replaceChildren();
});

function renderSidebarToStaticMarkup(Sidebar: React.ComponentType): string {
    return renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(Sidebar),
        ),
    );
}

async function mountSidebar() {
    const { Sidebar } = await import("../../components/layout/Sidebar");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(Sidebar),
            ),
        );
    });

    return {
        container,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("returns null for auth routes", async () => {
    state.pathname = "/login";

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderSidebarToStaticMarkup(Sidebar);

    assert.equal(html, "");
    assert.equal(state.likedQueryCalls, 0);
    assert.equal(state.playlistQueryCalls, 0);
});

test("mobile and tablet shells do not start desktop playlist queries", async () => {
    const { Sidebar } = await import("../../components/layout/Sidebar");

    state.isMobile = true;
    const mobileHtml = renderSidebarToStaticMarkup(Sidebar);
    assert.match(mobileHtml, /mobile-sidebar/);
    assert.equal(state.likedQueryCalls, 0);
    assert.equal(state.playlistQueryCalls, 0);

    state.isMobile = false;
    state.isTablet = true;
    const tabletHtml = renderSidebarToStaticMarkup(Sidebar);
    assert.match(tabletHtml, /mobile-sidebar/);
    assert.equal(state.likedQueryCalls, 0);
    assert.equal(state.playlistQueryCalls, 0);
});

test("keeps global search in the top bar instead of duplicating it in navigation", async () => {
    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderSidebarToStaticMarkup(Sidebar);

    assert.match(html, />Главная</);
    assert.doesNotMatch(html, />Search</);
    assert.doesNotMatch(html, /href="\/search"/);
    assert.match(html, />Моя музыка</);
    assert.match(html, />Волна</);
    assert.doesNotMatch(html, />Explore</);
    assert.doesNotMatch(html, />Listen Together</);
    assert.doesNotMatch(html, />Audiobooks</);
    assert.doesNotMatch(html, />Podcasts</);
    assert.doesNotMatch(html, /My History/);
});

test("keeps prefetch enabled for primary sidebar navigation links", async () => {
    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderSidebarToStaticMarkup(Sidebar);

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

test("desktop sidebar exposes liked tracks, playlist creation, and direct playlist links", async () => {
    state.playlists = [
        { id: "playlist-1", name: "Для дороги", trackCount: 12 },
        { id: "playlist-2", name: "Скрытый", trackCount: 3, isHidden: true },
        {
            id: "playlist-shared",
            name: "Чужой плейлист",
            trackCount: 7,
            isOwner: false,
        },
        { id: "playlist-3", name: "Спокойный вечер", trackCount: 21 },
    ];

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderSidebarToStaticMarkup(Sidebar);

    assert.match(html, /data-shell-sidebar="desktop"/);
    assert.match(html, /data-shell-navigation="primary"/);
    assert.match(html, /data-shell-library-shortcuts="compact"/);
    const sidebar = html.match(
        /<aside[^>]*data-shell-sidebar="desktop"[^>]*>/,
    )?.[0];
    assert.ok(sidebar);
    assert.match(sidebar, /w-\[248px\]/);
    assert.doesNotMatch(sidebar, /rounded-/);
    assert.match(html, /href="\/playlist\/my-liked"/);
    assert.match(html, />Любимые треки</);
    assert.match(html, /href="\/playlist\/playlist-1"/);
    assert.match(html, /href="\/playlist\/playlist-3"/);
    assert.match(html, />Для дороги</);
    assert.match(html, />Спокойный вечер</);
    assert.match(html, /12 треков/);
    assert.doesNotMatch(html, /Скрытый/);
    assert.doesNotMatch(html, /Чужой плейлист/);
    assert.doesNotMatch(html, /href="\/playlists"/);
    assert.match(html, /aria-label="Создать плейлист"/);
    assert.match(html, />Создать плейлист</);
    assert.doesNotMatch(html, /Сортировка и фильтры|Все плейлисты/);
    assert.match(html, /data-shell-playlist-list="personal"/);
    const playlistList = html.match(
        /<nav[^>]*data-shell-playlist-list="personal"[^>]*>/,
    )?.[0];
    assert.ok(playlistList);
    assert.match(playlistList, /scrollbar-hide/);
    assert.doesNotMatch(playlistList, /scrollbar-width:thin/);
    assert.doesNotMatch(html, /Peer Jams|peer-badge:/);
    assert.doesNotMatch(html, /Sync Library/);
});

test("limits permanent playlist shortcuts and shows All playlists only for overflow", async () => {
    state.playlists = Array.from({ length: 52 }, (_, index) => ({
        id: `playlist-${index + 1}`,
        name: `Плейлист ${index + 1}`,
        trackCount: index + 1,
    }));

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderSidebarToStaticMarkup(Sidebar);

    assert.equal(
        html.match(/data-shell-playlist-shortcut="personal"/g)?.length,
        50,
    );
    assert.match(html, /href="\/playlist\/playlist-50"/);
    assert.doesNotMatch(html, /href="\/playlist\/playlist-51"/);
    assert.match(html, /href="\/playlists"/);
    assert.match(html, />Все плейлисты</);

    state.playlists = state.playlists.slice(0, 4);
    const compactHtml = renderSidebarToStaticMarkup(Sidebar);
    assert.doesNotMatch(compactHtml, /href="\/playlists"/);
    assert.doesNotMatch(compactHtml, />Все плейлисты</);
});

test("short desktop shows one direct playlist and a stable All playlists escape", async () => {
    state.isShortDesktop = true;
    state.playlists = Array.from({ length: 4 }, (_, index) => ({
        id: `playlist-${index + 1}`,
        name: `Плейлист ${index + 1}`,
        trackCount: index + 1,
    }));

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderSidebarToStaticMarkup(Sidebar);

    assert.equal(
        html.match(/data-shell-playlist-shortcut="personal"/g)?.length,
        1,
    );
    assert.match(html, /href="\/playlist\/playlist-1"/);
    assert.doesNotMatch(html, /href="\/playlist\/playlist-2"/);
    assert.match(html, /data-shell-playlist-overflow="true"/);
    assert.match(html, />Все плейлисты</);
    assert.match(html, />\+3</);
});

test("playlist events invalidate the sidebar query", async () => {
    const harness = await mountSidebar();
    try {
        await React.act(async () => {
            for (const eventName of [
                "playlist-created",
                "playlist-updated",
                "playlist-deleted",
            ]) {
                window.dispatchEvent(new Event(eventName));
            }
            await Promise.resolve();
        });

        assert.deepEqual(state.invalidatedQueries, [
            { queryKey: ["playlists"] },
            { queryKey: ["playlists"] },
            { queryKey: ["playlists"] },
        ]);
    } finally {
        await harness.unmount();
    }
});

test("playlist list exposes a compact retry after a query failure", async () => {
    state.playlistsError = true;
    const harness = await mountSidebar();
    try {
        const alert = harness.container.querySelector('[role="alert"]');
        assert.ok(alert);
        assert.match(alert.textContent ?? "", /Не удалось загрузить плейлисты/);
        const retry = Array.from(
            harness.container.querySelectorAll("button"),
        ).find((button) => button.textContent?.includes("Повторить"));
        assert.ok(retry instanceof HTMLButtonElement);

        await React.act(async () => {
            retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await Promise.resolve();
        });
        assert.equal(state.playlistRefetchCalls, 1);
    } finally {
        await harness.unmount();
    }
});

test("desktop Library navigation can enter the precached Downloads shell offline", async () => {
    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderSidebarToStaticMarkup(Sidebar);

    const libraryLink = html.match(/<a[^>]*href="\/library"[^>]*>/);
    assert.ok(libraryLink, "Expected desktop Library link");
    assert.match(libraryLink[0], /data-has-on-click="true"/);
});

test("keeps federated peer playlist details outside the personal shell list", async () => {
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
    const html = renderSidebarToStaticMarkup(Sidebar);

    assert.doesNotMatch(html, /Peer Jams/);
    assert.doesNotMatch(html, /peer-badge:Family server/);
});

test("renders the liked shortcut in Russian without an empty playlist panel", async () => {
    state.likedTotal = 21;

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderSidebarToStaticMarkup(Sidebar);

    assert.match(html, /Любимые треки/);
    assert.match(html, /21 трек/);
    assert.doesNotMatch(html, /Плейлистов пока нет/);
    assert.doesNotMatch(html, /Создайте первый плейлист/);
    assert.doesNotMatch(html, /My Liked|No playlists yet/);
});

test("marks the matching direct playlist link as current", async () => {
    state.pathname = "/playlist/playlist-42";
    state.playlists = [
        { id: "playlist-42", name: "В дорогу", trackCount: 8 },
        { id: "playlist-7", name: "Работа", trackCount: 16 },
    ];

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderSidebarToStaticMarkup(Sidebar);

    const playlistLink = html.match(
        /<a[^>]*href="\/playlist\/playlist-42"[^>]*>/,
    )?.[0];
    const otherPlaylistLink = html.match(
        /<a[^>]*href="\/playlist\/playlist-7"[^>]*>/,
    )?.[0];
    const likedLink = html.match(
        /<a[^>]*href="\/playlist\/my-liked"[^>]*>/,
    )?.[0];
    assert.ok(playlistLink);
    assert.ok(otherPlaylistLink);
    assert.ok(likedLink);
    assert.match(playlistLink, /aria-current="page"/);
    assert.doesNotMatch(otherPlaylistLink, /aria-current="page"/);
    assert.doesNotMatch(likedLink, /aria-current="page"/);
});

test("keeps My Liked active without also selecting a personal playlist", async () => {
    state.pathname = "/playlist/my-liked";
    state.playlists = [{ id: "playlist-42", name: "В дорогу", trackCount: 8 }];

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderSidebarToStaticMarkup(Sidebar);

    const playlistLink = html.match(
        /<a[^>]*href="\/playlist\/playlist-42"[^>]*>/,
    )?.[0];
    const likedLink = html.match(
        /<a[^>]*href="\/playlist\/my-liked"[^>]*>/,
    )?.[0];
    assert.ok(playlistLink);
    assert.ok(likedLink);
    assert.doesNotMatch(playlistLink, /aria-current="page"/);
    assert.match(likedLink, /aria-current="page"/);
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
    const html = renderSidebarToStaticMarkup(Sidebar);

    assert.doesNotMatch(html, /Peer Jams/);
    assert.doesNotMatch(html, /peer-badge:/);
});
