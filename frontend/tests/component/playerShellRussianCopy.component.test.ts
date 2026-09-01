import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const Icon = (props: Record<string, unknown>) =>
    React.createElement("svg", props);

const mediaInfoState: {
    currentTrack: {
        id: string;
        title: string;
        artist?: { id?: string; name: string };
        album?: { id?: string; coverArt?: string | null };
    } | null;
    currentAudiobook: null;
    currentPodcast: null;
    playbackType: "track" | null;
} = {
    currentTrack: null,
    currentAudiobook: null,
    currentPodcast: null,
    playbackType: null,
};

mock.module("lucide-react", {
    namedExports: {
        ChevronRight: Icon,
        Crown: Icon,
        Info: Icon,
        Loader2: Icon,
        Music: Icon,
        RefreshCw: Icon,
        Users: Icon,
        Wifi: Icon,
        WifiOff: Icon,
        X: Icon,
    },
});

mock.module("next/link", {
    defaultExport: ({
        href,
        children,
        prefetch: _prefetch,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
        prefetch?: boolean;
    }) => React.createElement("a", { href, ...rest }, children),
});

mock.module("next/image", {
    defaultExport: ({ src, alt }: { src: string; alt: string }) =>
        React.createElement("img", { src, alt }),
});

mock.module("@/lib/logger", {
    namedExports: {
        createFrontendLogger: () => ({
            error: () => undefined,
        }),
    },
});

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => mediaInfoState,
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (value: string) => `/cover/${value}`,
        },
    },
});

mock.module("@/utils/artistRoute", {
    namedExports: {
        getArtistHref: ({ id }: { id?: string }) =>
            id ? `/artist/${id}` : null,
    },
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: {
        TidalBadge: () => React.createElement("span", null, "TIDAL"),
    },
});

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: {
        YouTubeBadge: () => React.createElement("span", null, "YouTube"),
    },
});

mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: { TrackPreferenceButtons: () => null },
});

mock.module("@/hooks/useTrackPreference", {
    namedExports: { buildPreferenceMetadata: () => ({}) },
});

mock.module("@/lib/listen-together-context", {
    namedExports: {
        useListenTogether: () => ({
            isInGroup: true,
            isConnected: true,
            activeGroup: {
                name: "Комната",
                members: [
                    {
                        userId: "u1",
                        username: "Слушатель",
                        isHost: true,
                        isConnected: true,
                    },
                ],
            },
        }),
    },
});

mock.module("@/hooks/useMediaQuery", {
    namedExports: { useIsMobile: () => false },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("framer-motion", {
    namedExports: {
        motion: {
            section: ({
                children,
                ...props
            }: {
                children?: React.ReactNode;
                [key: string]: unknown;
            }) => React.createElement("section", props, children),
        },
        useReducedMotion: () => true,
    },
});

mock.module("@/hooks/useLyrics", {
    namedExports: {
        useLyrics: () => ({
            data: null,
            isLoading: false,
            isError: true,
        }),
    },
});

mock.module("@/components/player/SyncedLyrics", {
    namedExports: { SyncedLyrics: () => null },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

test("metadata display fallbacks are Russian", async () => {
    const { useAlbumDisplayData, useArtistDisplayData } =
        await import("../../hooks/useMetadataDisplay");

    assert.equal(useArtistDisplayData(null).name, "Неизвестный исполнитель");
    assert.equal(useArtistDisplayData({}).name, "Неизвестный исполнитель");
    assert.equal(useAlbumDisplayData(null).title, "Неизвестный альбом");
    assert.equal(useAlbumDisplayData({}).title, "Неизвестный альбом");
});

test("media info uses Russian idle and missing-artist copy", async () => {
    const { useMediaInfo } = await import("../../hooks/useMediaInfo");

    function Probe() {
        const info = useMediaInfo();
        return React.createElement(
            "div",
            null,
            React.createElement("span", null, info.title),
            React.createElement("span", null, info.subtitle),
        );
    }

    mediaInfoState.currentTrack = null;
    mediaInfoState.playbackType = null;
    const idleHtml = renderToStaticMarkup(React.createElement(Probe));
    assert.match(idleHtml, /Ничего не воспроизводится/);
    assert.match(idleHtml, /Выберите, что послушать/);

    mediaInfoState.currentTrack = { id: "t1", title: "Трек" };
    mediaInfoState.playbackType = "track";
    const trackHtml = renderToStaticMarkup(React.createElement(Probe));
    assert.match(trackHtml, /Неизвестный исполнитель/);
});

test("global fallback is Russian and does not expose an internal error", async () => {
    const { GlobalErrorBoundary } =
        await import("../../components/providers/GlobalErrorBoundary");
    const boundary = new GlobalErrorBoundary({
        children: React.createElement("div", null, "content"),
    });
    (
        boundary as unknown as {
            state: { hasError: boolean; error: Error | null };
        }
    ).state = {
        hasError: true,
        error: new Error("secret backend detail"),
    };

    const html = renderToStaticMarkup(boundary.render() as React.ReactElement);
    assert.match(html, /Что-то пошло не так/);
    assert.match(html, /Перезагрузить страницу/);
    assert.doesNotMatch(html, /secret backend detail|Something went wrong/);
});

test("section links and related-player states use Russian copy", async () => {
    const { SectionHeader } =
        await import("../../features/home/components/SectionHeader");
    const { RelatedSectionShell, SimilarSongsList } =
        await import("../../components/player/overlay-tabs/OverlayRelatedSections");
    const { getRelatedTrackKey } =
        await import("../../lib/overlay-related-matching");

    const headerHtml = renderToStaticMarkup(
        React.createElement(SectionHeader, {
            title: "Раздел",
            showAllHref: "/all",
        }),
    );
    assert.match(headerHtml, /Показать все/);

    const RelatedSectionShellForTest =
        RelatedSectionShell as unknown as React.ComponentType<
            Record<string, unknown>
        >;
    const errorHtml = renderToStaticMarkup(
        React.createElement(
            RelatedSectionShellForTest,
            {
                title: "Похожее",
                isLoading: false,
                isError: true,
                onRetry: () => undefined,
                errorText: "Ошибка",
                isEmpty: false,
                emptyText: "Пусто",
            },
            React.createElement("div", null, "content"),
        ),
    );
    assert.match(errorHtml, /Повторить/);

    const matchingTrack = {
        id: "matching",
        title: "Matching",
        artist: "Artist",
        inLibrary: false,
    };
    const listHtml = renderToStaticMarkup(
        React.createElement(SimilarSongsList, {
            tracks: [
                {
                    id: "library",
                    title: "Library",
                    artist: "Artist",
                    inLibrary: true,
                },
                matchingTrack,
                {
                    id: "info",
                    title: "Info",
                    artist: "Artist",
                    inLibrary: false,
                    lastFmUrl: "https://last.fm/track",
                },
                {
                    id: "search",
                    title: "Search",
                    artist: "Artist",
                    inLibrary: false,
                },
            ],
            streamMatches: {},
            matchingTrackKey: getRelatedTrackKey(matchingTrack),
            onPlayRelatedTrack: () => undefined,
        }),
    );
    assert.match(listHtml, /В коллекции/);
    assert.match(listHtml, /Подбираем/);
    assert.match(listHtml, /Информация/);
    assert.match(listHtml, /Найти/);
});

test("lyrics failure is presented in Russian", async () => {
    const { OverlayLyricsTab } =
        await import("../../components/player/overlay-tabs/OverlayLyricsTab");
    const html = renderToStaticMarkup(
        React.createElement(OverlayLyricsTab, {
            lookupTrack: { id: "t1", title: "Трек" },
            currentTime: 0,
            isPlaying: false,
            onSeek: () => undefined,
        }),
    );

    assert.match(html, /Не удалось загрузить текст песни/);
    assert.doesNotMatch(html, /Failed to load lyrics/);
});

test("keyboard and Listen Together player affordances use Russian copy", async (t) => {
    const { createRoot } = await import("react-dom/client");
    const { KeyboardShortcutsTooltip } =
        await import("../../components/player/KeyboardShortcutsTooltip");
    const { SyncBadge } = await import("../../components/player/SyncBadge");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => {
        await React.act(async () => root.unmount());
        container.remove();
    });

    await React.act(async () => {
        root.render(React.createElement(KeyboardShortcutsTooltip));
    });
    await React.act(async () => {
        container.querySelector<HTMLButtonElement>("button")?.click();
    });
    assert.match(container.textContent ?? "", /Сочетания клавиш/);
    assert.match(
        container.textContent ?? "",
        /Сочетания работают везде, кроме полей ввода текста/,
    );

    const syncHtml = renderToStaticMarkup(React.createElement(SyncBadge));
    assert.match(syncHtml, /Открыть совместное прослушивание/);
});
