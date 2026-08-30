import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const icon = (name: string) => {
    const MockIcon = (props: Record<string, unknown> = {}) =>
        React.createElement("svg", { ...props, "data-icon": name });
    MockIcon.displayName = `MockIcon${name}`;
    return MockIcon;
};

mock.module("lucide-react", {
    namedExports: {
        Play: icon("play"),
        Pause: icon("pause"),
        Shuffle: icon("shuffle"),
        Download: icon("download"),
        Radio: icon("radio"),
        ListMusic: icon("list-music"),
        Loader2: icon("loader2"),
        Plus: icon("plus"),
        Heart: icon("heart"),
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            error: () => undefined,
            success: () => undefined,
        },
    },
});

mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: false,
            trigger: () => undefined,
        }),
    },
});

const noop = () => undefined;

const baseArtist = { id: "artist-1", name: "Test Artist" };
const baseAlbums = [
    {
        id: "album-1",
        title: "Album One",
        year: 2024,
        owned: true,
        availability: "available",
    },
];

const baseProps = {
    artist: baseArtist,
    albums: baseAlbums,
    source: "library" as const,
    colors: null,
    onPlayAll: noop,
    onShuffle: noop,
    onDownloadAll: noop,
    isPendingDownload: false,
    isPlaying: false,
    isPlayingThisArtist: false,
    downloadsEnabled: true,
};

test("ArtistActionBar renders personal controls without server acquisition", async () => {
    const { ArtistActionBar } =
        await import("../../features/artist/components/ArtistActionBar");
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            onAddAllToQueue: noop,
            onAddToPlaylist: noop,
            onLikeAll: noop,
            onStartRadio: noop,
            deviceDownloadControl: React.createElement(
                "button",
                null,
                "Download to this device",
            ),
        }),
    );

    // Online-first order: playback, personal organization, device copy, radio.
    assert.match(html, /<span>Воспроизвести всё<\/span>/);
    assert.match(html, /title="Перемешать"/);
    assert.match(html, /title="Добавить всё в очередь"/);
    assert.match(html, /title="Добавить в плейлист"/);
    assert.match(html, /title="Поставить лайк всем трекам"/);
    assert.match(html, /Download to this device/);
    assert.doesNotMatch(html, /Download all missing albums/);
    assert.match(html, /title="Включить радио исполнителя"/);
});

test("ArtistActionBar renders the explicit personal-library control", async () => {
    const { ArtistActionBar } =
        await import("../../features/artist/components/ArtistActionBar");
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            librarySaveControl: React.createElement(
                "button",
                null,
                "Save to Library",
            ),
        }),
    );

    assert.match(html, /Save to Library/);
});

test("ArtistActionBar never exposes server queueing state", async () => {
    const { ArtistActionBar } =
        await import("../../features/artist/components/ArtistActionBar");
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            isPendingDownload: true,
        }),
    );

    assert.doesNotMatch(html, /title="Queueing missing albums"/);
    assert.doesNotMatch(html, /title="Download all missing albums"/);
});

test("ArtistActionBar icon controls are touch-sized and have accessible names", async () => {
    const { ArtistActionBar } =
        await import("../../features/artist/components/ArtistActionBar");
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            onAddAllToQueue: noop,
            onAddToPlaylist: noop,
            onLikeAll: noop,
            onStartRadio: noop,
        }),
    );

    for (const label of [
        "Перемешать",
        "Добавить всё в очередь",
        "Добавить в плейлист",
        "Поставить лайк всем трекам",
        "Включить радио исполнителя",
    ]) {
        const button = html.match(
            new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`),
        )?.[0];
        assert.ok(button, `missing accessible button: ${label}`);
        assert.match(button, /h-11 w-11/);
    }
    assert.match(html, /w-full/);
    assert.match(html, /sm:w-fit/);
});

test("ArtistActionBar hides Add to Queue when callback is not provided", async () => {
    const { ArtistActionBar } =
        await import("../../features/artist/components/ArtistActionBar");
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            // onAddAllToQueue not provided
            onAddToPlaylist: noop,
            onLikeAll: noop,
        }),
    );

    assert.doesNotMatch(html, /title="Добавить всё в очередь"/);
    assert.match(html, /title="Добавить в плейлист"/);
});

test("ArtistActionBar hides Add to Playlist and Like All for non-library artist", async () => {
    const { ArtistActionBar } =
        await import("../../features/artist/components/ArtistActionBar");
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            source: "discovery" as const,
            // Non-library: no playlist/like callbacks
        }),
    );

    assert.doesNotMatch(html, /title="Добавить в плейлист"/);
    assert.doesNotMatch(html, /title="Поставить лайк всем трекам"/);
    // Play and Shuffle should still be there
    assert.match(html, /<span>Воспроизвести всё<\/span>/);
    assert.match(html, /title="Перемешать"/);
});

test("ArtistActionBar shows Pause when artist is currently playing", async () => {
    const { ArtistActionBar } =
        await import("../../features/artist/components/ArtistActionBar");
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            isPlaying: true,
            isPlayingThisArtist: true,
        }),
    );

    assert.match(html, /<span>Пауза<\/span>/);
    assert.match(html, /data-icon="pause"/);
    assert.doesNotMatch(html, /<span>Воспроизвести всё<\/span>/);
});

test("ArtistActionBar shows spinner on Like All button when isLikingAll is true", async () => {
    const { ArtistActionBar } =
        await import("../../features/artist/components/ArtistActionBar");
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            onLikeAll: noop,
            isLikingAll: true,
        }),
    );

    assert.match(html, /title="Поставить лайк всем трекам"/);
    assert.match(html, /data-icon="loader2"/);
    assert.doesNotMatch(html, /data-icon="heart"/);
});

test("ArtistActionBar shows heart icon when not liking", async () => {
    const { ArtistActionBar } =
        await import("../../features/artist/components/ArtistActionBar");
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            onLikeAll: noop,
            isLikingAll: false,
        }),
    );

    assert.match(html, /data-icon="heart"/);
});

test("ArtistActionBar hides download button when downloadsEnabled is false", async () => {
    const { ArtistActionBar } =
        await import("../../features/artist/components/ArtistActionBar");
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            downloadsEnabled: false,
            // source is library and albums have availability != unavailable
            // but downloadsEnabled overrides
        }),
    );

    assert.doesNotMatch(html, /title="Download all missing albums"/);
});

test("ArtistActionBar shows Listen Together locked state", async () => {
    const { ArtistActionBar } =
        await import("../../features/artist/components/ArtistActionBar");
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            isInListenTogetherGroup: true,
            onAddAllToQueue: noop,
        }),
    );

    // Play and Shuffle should be locked (different styling, no standard buttons)
    assert.match(html, /Идёт совместное прослушивание/);
    // Add to Queue should still appear (not locked)
    assert.match(html, /title="Добавить всё в очередь"/);
});
