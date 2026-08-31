import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

const podcast = {
    id: "podcast-1",
    title: "Технологии без шума",
    author: "Студия Soundspan",
    coverUrl: "",
    episodeCount: 12,
};

mock.module("lucide-react", {
    namedExports: {
        ArrowLeft: Icon,
        Book: Icon,
        CheckCircle: Icon,
        Clock: Icon,
        Link2: Icon,
        ListTree: Icon,
        Loader2: Icon,
        Mic2: Icon,
        Pause: Icon,
        Play: Icon,
        Plus: Icon,
        Search: Icon,
        Shuffle: Icon,
    },
});

mock.module("next/navigation", {
    namedExports: {
        useParams: () => ({ genreId: "1303", name: "Большая серия" }),
        useRouter: () => ({
            back: () => undefined,
            push: () => undefined,
            replace: () => undefined,
        }),
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", {
            src: props.src,
            alt: props.alt,
        }),
});

mock.module("next/link", {
    defaultExport: ({
        children,
        href,
        ...props
    }: {
        children: React.ReactNode;
        href: string;
        [key: string]: unknown;
    }) => React.createElement("a", { href, ...props }, children),
});

mock.module("next/dynamic", {
    defaultExport: () => () =>
        React.createElement("section", { "data-admin-section": true }),
});

const testRequire = createRequire(`${process.cwd()}/package.json`);

mock.module("@/hooks/useQueries", {
    namedExports: {
        useAudiobooksQuery: () => ({
            data: [],
            error: null,
            isLoading: false,
        }),
        usePodcastsQuery: () => ({
            data: [podcast],
            isLoading: false,
        }),
        useTopPodcastsQuery: () => ({
            data: [podcast],
            isLoading: false,
        }),
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({
            isAuthenticated: true,
            isLoading: false,
            user: { role: "admin" },
        }),
    },
});

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => ({ federation: false }),
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

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioControls: () => ({
            pause: () => undefined,
            playAudiobook: () => undefined,
            resume: () => undefined,
        }),
        useAudioState: () => ({
            currentAudiobook: null,
            playbackType: null,
        }),
        usePlaybackStatus: () => ({ isPlaying: false }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            discoverSearch: async () => ({ results: [] }),
            getAudiobookSeries: async () => [],
            getCoverArtUrl: (url: string) => url,
            getPeerPodcasts: async () => [],
            getPodcastsByGenre: async () => ({}),
            getPodcastsByGenrePaginated: async () => [],
            subscribePodcast: async () => ({ success: false }),
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        createFrontendLogger: () => ({ error: () => undefined }),
        frontendLogger: { error: () => undefined },
    },
});

mock.module("@/components/layout/PageHeader", {
    namedExports: {
        PageHeader: ({
            title,
            subtitle,
            actions,
        }: {
            title: string;
            subtitle?: string;
            actions?: React.ReactNode;
        }) =>
            React.createElement(
                "header",
                { "data-page-header": true },
                title,
                subtitle,
                actions,
            ),
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: () => React.createElement("span", null, "spinner"),
    },
});

mock.module("@/components/ui/LoadingScreen", {
    namedExports: {
        LoadingScreen: ({ message }: { message?: string }) =>
            React.createElement(
                "div",
                { "data-loading-screen": true },
                message,
            ),
    },
});

mock.module("@/components/ui/EmptyState", {
    namedExports: {
        EmptyState: ({
            title,
            description,
        }: {
            title: string;
            description?: string;
        }) =>
            React.createElement(
                "div",
                { "data-empty-state": true },
                title,
                description,
            ),
    },
});

mock.module("@/components/ui/Button", {
    namedExports: {
        Button: ({
            children,
            ...props
        }: {
            children: React.ReactNode;
            [key: string]: unknown;
        }) => React.createElement("button", props, children),
    },
});

mock.module("@/components/ui/Card", {
    namedExports: {
        Card: ({ children }: { children: React.ReactNode }) =>
            React.createElement("div", null, children),
    },
});

mock.module("@/components/ui/Badge", {
    namedExports: {
        Badge: ({ children }: { children: React.ReactNode }) =>
            React.createElement("span", null, children),
    },
});

mock.module("@/components/ui/CachedImage", {
    namedExports: {
        CachedImage: (props: Record<string, unknown>) =>
            React.createElement("img", props),
    },
});

mock.module("@/components/ui/PeerBadge", {
    namedExports: {
        PeerBadge: () => React.createElement("span", null, "peer"),
    },
});

mock.module("@/features/settings/components/ui", {
    namedExports: {
        SettingsLayout: ({
            children,
            title,
        }: {
            children: React.ReactNode;
            title: string;
        }) =>
            React.createElement(
                "main",
                { "data-settings-layout": true },
                title,
                children,
            ),
    },
});

mock.module("@/features/settings/hooks/useSystemSettings", {
    namedExports: {
        useSystemSettings: () => ({
            changedServices: [],
            isLoading: false,
            loadError: null,
            loadSystemSettings: async () => undefined,
            saveSystemSettings: async () => [],
            systemSettings: {},
            testService: async () => true,
            updateSystemSettings: () => undefined,
        }),
    },
});

mock.module("@/components/ui/InlineStatus", {
    namedExports: {
        InlineStatus: () => null,
        useInlineStatus: () => ({
            props: {},
            setError: () => undefined,
            setLoading: () => undefined,
            setSuccess: () => undefined,
        }),
    },
});

mock.module("@/components/ui/RestartModal", {
    namedExports: {
        RestartModal: () => null,
    },
});

test("podcast catalog exposes an open, keyboard-native discovery stage", async () => {
    const { default: PodcastsPage } = await import("../../app/podcasts/page");
    const { QueryClient, QueryClientProvider } = testRequire(
        "@tanstack/react-query",
    ) as typeof import("@tanstack/react-query");
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(PodcastsPage),
        ),
    );

    assert.match(html, /data-routed-surface="podcasts"/);
    assert.match(html, /data-page-header="true"/);
    assert.match(html, /aria-label="Найти подкаст"/);
    assert.match(html, /aria-label="RSS-адрес подкаста"/);
    assert.match(html, /<button[^>]*data-podcast-card="open"/);
    assert.match(html, /data-podcast-card="open"[^>]*motion-reduce:/);
});

test("audiobook catalog keeps responsive filters on the shared stage", async () => {
    const { default: AudiobooksPage } =
        await import("../../app/audiobooks/page");
    const html = renderToStaticMarkup(React.createElement(AudiobooksPage));

    assert.match(html, /data-routed-surface="audiobooks"/);
    assert.match(html, /data-page-header="true"/);
    assert.match(html, /role="group" aria-label="Фильтр аудиокниг"/);
    assert.match(html, /aria-pressed="true"[^>]*min-h-11/);
    assert.match(html, /data-empty-state="true"/);
});

test("admin keeps its save action and states inside the routed stage", async () => {
    const { default: AdminPage } = await import("../../app/admin/page");
    const html = renderToStaticMarkup(React.createElement(AdminPage));

    assert.match(html, /data-routed-surface="admin"/);
    assert.match(html, /data-settings-layout="true"/);
    assert.match(html, /data-admin-save="true"[^>]*min-h-12/);
    assert.match(html, /data-admin-save="true"[^>]*bg-brand/);
});

test("podcast genre route has shared header, empty state and a touch-safe back action", async () => {
    const { default: GenrePage } =
        await import("../../app/podcasts/genre/[genreId]/page");
    const html = renderToStaticMarkup(React.createElement(GenrePage));

    assert.match(html, /data-routed-surface="podcast-genre"/);
    assert.match(html, /data-page-header="true"/);
    assert.match(html, /aria-label="Назад к подкастам"[^>]*min-h-11/);
    assert.match(html, /data-empty-state="true"/);
});

test("series and route-level waits use the shared Russian loading presentation", async () => {
    const [series, adminLoading, podcastsLoading, audiobooksLoading] =
        await Promise.all([
            import("../../app/audiobooks/series/[name]/page"),
            import("../../app/admin/loading"),
            import("../../app/podcasts/loading"),
            import("../../app/audiobooks/loading"),
        ]);

    const outputs = [
        renderToStaticMarkup(React.createElement(series.default)),
        renderToStaticMarkup(React.createElement(adminLoading.default)),
        renderToStaticMarkup(React.createElement(podcastsLoading.default)),
        renderToStaticMarkup(React.createElement(audiobooksLoading.default)),
    ];

    for (const html of outputs) {
        assert.match(html, /data-loading-screen="true"/);
        assert.match(html, /[А-Яа-яЁё]/);
    }
});

test("audiobook card is one focusable, reduced-motion collection link", async () => {
    const { AudiobookCard } = await import("../../components/ui/AudiobookCard");
    const html = renderToStaticMarkup(
        React.createElement(AudiobookCard, {
            id: "book-1",
            title: "Город и музыка",
            author: "Иван Петров",
            coverUrl: null,
            getCoverUrl: (url: string) => url,
        }),
    );

    assert.match(html, /data-audiobook-card="open"/);
    assert.match(html, /focus-visible:ring-2/);
    assert.match(html, /motion-reduce:/);
});
