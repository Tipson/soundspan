import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        Search: Icon,
        Music: Icon,
        Download: Icon,
        CheckCircle: Icon,
    },
});

mock.module("@/lib/tv-utils", {
    namedExports: { useIsTV: () => true },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", {
            src: props.src as string,
            alt: props.alt as string,
        }),
});

mock.module("next/link", {
    defaultExport: ({
        href,
        children,
        ...props
    }: React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
        React.createElement("a", { ...props, href }, children),
});

mock.module("@/components/ui/PeerBadge", {
    namedExports: { PeerBadge: () => React.createElement("span") },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (value: string) => value,
        },
    },
});

test("TV search explains its keyboard action in Russian", async () => {
    const { TVSearchInput } =
        await import("../../features/search/components/TVSearchInput");
    const html = renderToStaticMarkup(
        React.createElement(TVSearchInput, {
            initialQuery: "Кино",
            onSearch: () => undefined,
        }),
    );

    assert.match(html, /Поиск музыки/);
    assert.match(html, /Нажмите Enter, чтобы найти/);
    assert.doesNotMatch(html, /Search music|Press Enter to search/);
});

test("Soulseek fallback results expose Russian actions and fallback metadata", async () => {
    const { SoulseekSongsList } =
        await import("../../features/search/components/SoulseekSongsList");
    const html = renderToStaticMarkup(
        React.createElement(SoulseekSongsList, {
            soulseekResults: [
                {
                    username: "peer",
                    path: "mystery.mp3",
                    filename: "mystery.mp3",
                    size: 1_024,
                    bitrate: 320,
                    format: "mp3",
                },
            ],
            downloadingFiles: new Set<string>(),
            onDownload: () => undefined,
        }),
    );

    assert.match(html, /Файлы для загрузки/);
    assert.match(html, /Неизвестный исполнитель/);
    assert.match(html, />Скачать</);
    assert.doesNotMatch(html, /Downloadable matches|Downloading|>Download</);
});

test("artist search cards use Russian type and listener labels", async () => {
    const { SearchArtistsGrid } =
        await import("../../features/search/components/SearchArtistsGrid");
    const html = renderToStaticMarkup(
        React.createElement(SearchArtistsGrid, {
            libraryArtists: [{ id: "local-kino", name: "Кино", heroUrl: "" }],
            discoveryArtists: [
                {
                    type: "music",
                    name: "Сплин",
                    listeners: 1_200,
                },
            ],
            limit: null,
        } as never),
    );

    assert.match(html, /Исполнитель/);
    assert.match(html, /1,2 тыс\. слушателей/);
    assert.doesNotMatch(html, />Artist<|listeners/);
});
