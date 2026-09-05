import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
    installTrackOverflowHarness,
    trackOverflowIcon,
} from "../trackOverflowHarness";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const copied: string[] = [];
const playedQueues: unknown[][] = [];
const playedNextTracks: Array<Record<string, unknown>> = [];
const lookedUpTracks: Array<Record<string, unknown>> = [];
const downloadedTracks: Array<Record<string, unknown>> = [];

mock.module("lucide-react", {
    namedExports: {
        EllipsisVertical: trackOverflowIcon,
        Link: trackOverflowIcon,
        ListEnd: trackOverflowIcon,
        ListPlus: trackOverflowIcon,
        Map: trackOverflowIcon,
        Plus: trackOverflowIcon,
        Share2: trackOverflowIcon,
        User: trackOverflowIcon,
        Disc3: trackOverflowIcon,
        AudioWaveform: trackOverflowIcon,
        Radio: trackOverflowIcon,
        Check: trackOverflowIcon,
        Download: trackOverflowIcon,
        Loader2: trackOverflowIcon,
    },
});

installTrackOverflowHarness(mock, {
    useAudioControls: () => ({
        playNext: (track: Record<string, unknown>) =>
            playedNextTracks.push(track),
        addToQueue: () => undefined,
        playTracks: (tracks: unknown[]) => playedQueues.push(tracks),
        playTrack: () => undefined,
        startVibeMode: async () => ({ success: true, trackCount: 10 }),
    }),
    useAudioState: () => ({ playbackType: "track", currentTrack: null }),
});

mock.module("next/navigation", {
    namedExports: { useRouter: () => ({ push: () => undefined }) },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            addTrackToPlaylist: async () => undefined,
            getStreamUrl: (id: string) => `/api/library/${id}`,
            getYtMusicStreamUrl: (id: string) => `/api/ytmusic/${id}`,
            getYouTubeStreamUrl: (id: string) => `/api/youtube/${id}`,
            getRadioTracks: async () => ({
                tracks: [
                    {
                        ...localTrack,
                        id: "tidal:222",
                        streamSource: "tidal",
                        tidalTrackId: 222,
                    },
                    {
                        ...localTrack,
                        id: "yt:radio-video",
                        streamSource: "youtube",
                        youtubeVideoId: "radio-video",
                    },
                ],
            }),
        },
    },
});

mock.module("@/features/device-offline/DeviceOfflineProvider", {
    namedExports: {
        useOptionalDeviceOffline: () => ({
            storage: { status: "ready", directoryName: "Music" },
            recordForTrack: (track: Record<string, unknown>) => {
                lookedUpTracks.push(track);
                return null;
            },
            download: async ({ track }: { track: Record<string, unknown> }) => {
                downloadedTracks.push(track);
                return { status: "ready" };
            },
        }),
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
    copied.length = 0;
    playedQueues.length = 0;
    playedNextTracks.length = 0;
    lookedUpTracks.length = 0;
    downloadedTracks.length = 0;
    Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: {
            writeText: (text: string) => {
                copied.push(text);
                return Promise.resolve();
            },
        },
    });
    window.location.href = "http://localhost/search";
});

const localTrack = {
    id: "track-1",
    title: "Test Track",
    artist: { name: "Test Artist", id: "artist-1" },
    album: { title: "Test Album", id: "album-1" },
    duration: 240,
};

async function renderMenu(track: unknown): Promise<{
    container: HTMLElement;
    unmount: () => void;
}> {
    const { TrackOverflowMenu } =
        await import("../../components/ui/TrackOverflowMenu");
    const { createRoot } = await import("react-dom/client");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(TrackOverflowMenu, { track: track as never }),
        );
    });
    // Open the menu.
    const trigger = container.querySelector('[aria-haspopup="menu"]');
    assert.ok(trigger, "menu trigger not found");
    await React.act(async () => {
        (trigger as HTMLElement).click();
    });
    return {
        container,
        unmount: () => {
            void React.act(() => {
                root.unmount();
            });
            container.remove();
        },
    };
}

function findMenuItem(
    container: HTMLElement,
    label: string,
): HTMLElement | null {
    const buttons = Array.from(container.querySelectorAll("button"));
    return (
        (buttons.find((button) =>
            button.textContent?.includes(label),
        ) as HTMLElement) ?? null
    );
}

test("copies an /album?track= link for a local track", async () => {
    const { container, unmount } = await renderMenu(localTrack);

    const item = findMenuItem(container, "Скопировать ссылку на трек");
    assert.ok(item, "Элемент копирования ссылки на трек не найден");
    await React.act(async () => {
        item!.click();
    });

    assert.deepEqual(copied, ["http://localhost/album/album-1?track=track-1"]);
    unmount();
});

test("hides the copy item for remote provider tracks", async () => {
    const { container, unmount } = await renderMenu({
        ...localTrack,
        streamSource: "youtube",
    });

    assert.equal(findMenuItem(container, "Скопировать ссылку на трек"), null);
    unmount();
});

test("hides the copy item when the track has no album id", async () => {
    const { container, unmount } = await renderMenu({
        ...localTrack,
        album: { title: "Test Album" },
    });

    assert.equal(findMenuItem(container, "Скопировать ссылку на трек"), null);
    unmount();
});

test("historical TIDAL keeps safe navigation but hides playback, playlist, and download actions", async () => {
    const { container, unmount } = await renderMenu({
        ...localTrack,
        id: "tidal:991",
        filePath: undefined,
        streamSource: "tidal",
        tidalTrackId: 991,
    });

    assert.equal(findMenuItem(container, "Воспроизвести следующим"), null);
    assert.equal(findMenuItem(container, "Добавить в очередь"), null);
    assert.equal(findMenuItem(container, "Добавить в плейлист"), null);
    assert.equal(findMenuItem(container, "Загрузить на устройство"), null);
    assert.ok(findMenuItem(container, "Открыть исполнителя"));
    const radio = findMenuItem(container, "Запустить радио");
    assert.ok(radio);
    await React.act(async () => {
        radio.click();
    });
    assert.deepEqual(
        playedQueues.map((tracks) =>
            tracks.map((track) => (track as { id: string }).id),
        ),
        [["yt:radio-video"]],
    );
    unmount();
});

test("a local file with stale TIDAL metadata keeps normal track actions", async () => {
    const { container, unmount } = await renderMenu({
        ...localTrack,
        id: "local-stale-tidal",
        filePath: "/music/local.flac",
        streamSource: "tidal",
        tidalTrackId: 991,
    });

    assert.ok(findMenuItem(container, "Воспроизвести следующим"));
    assert.ok(findMenuItem(container, "Добавить в очередь"));
    assert.ok(findMenuItem(container, "Добавить в плейлист"));
    const download = findMenuItem(container, "Загрузить на устройство");
    assert.ok(download);
    assert.deepEqual(
        {
            id: lookedUpTracks.at(-1)?.id,
            mediaSource: lookedUpTracks.at(-1)?.mediaSource,
            source: lookedUpTracks.at(-1)?.source,
            streamSource: lookedUpTracks.at(-1)?.streamSource,
            tidalTrackId: lookedUpTracks.at(-1)?.tidalTrackId,
        },
        {
            id: "local-stale-tidal",
            mediaSource: "local",
            source: "local",
            streamSource: undefined,
            tidalTrackId: undefined,
        },
    );
    await React.act(async () => download.click());
    assert.equal(downloadedTracks.at(-1), lookedUpTracks.at(-1));
    unmount();
});

test("a local file clears stale YouTube identity for queue and device actions", async () => {
    const { container, unmount } = await renderMenu({
        ...localTrack,
        id: "local-stale-youtube",
        filePath: "/music/local.flac",
        streamSource: "youtube",
        youtubeVideoId: "stale-video",
    });

    const playNext = findMenuItem(container, "Воспроизвести следующим");
    assert.ok(playNext);
    await React.act(async () => playNext.click());
    assert.deepEqual(
        {
            id: playedNextTracks.at(-1)?.id,
            mediaSource: playedNextTracks.at(-1)?.mediaSource,
            source: playedNextTracks.at(-1)?.source,
            streamSource: playedNextTracks.at(-1)?.streamSource,
            youtubeVideoId: playedNextTracks.at(-1)?.youtubeVideoId,
        },
        {
            id: "local-stale-youtube",
            mediaSource: "local",
            source: "local",
            streamSource: undefined,
            youtubeVideoId: undefined,
        },
    );

    await React.act(async () => {
        (
            container.querySelector('[aria-haspopup="menu"]') as HTMLElement
        ).click();
    });
    const download = findMenuItem(container, "Загрузить на устройство");
    assert.ok(download);
    assert.equal(lookedUpTracks.at(-1), playedNextTracks.at(-1));
    await React.act(async () => download.click());
    assert.equal(downloadedTracks.at(-1), playedNextTracks.at(-1));
    unmount();
});

test("active YouTube with stale TIDAL metadata uses one normalized device identity", async () => {
    const { container, unmount } = await renderMenu({
        ...localTrack,
        id: "tidal:992",
        source: "youtube",
        youtubeVideoId: "active-video",
        tidalTrackId: 992,
    });

    assert.deepEqual(
        {
            id: lookedUpTracks.at(-1)?.id,
            source: lookedUpTracks.at(-1)?.source,
            streamSource: lookedUpTracks.at(-1)?.streamSource,
            tidalTrackId: lookedUpTracks.at(-1)?.tidalTrackId,
            youtubeVideoId: lookedUpTracks.at(-1)?.youtubeVideoId,
        },
        {
            id: "tidal:992",
            source: "youtube",
            streamSource: "youtube",
            tidalTrackId: undefined,
            youtubeVideoId: "active-video",
        },
    );
    const download = findMenuItem(container, "Загрузить на устройство");
    assert.ok(download);
    await React.act(async () => download.click());
    assert.equal(downloadedTracks.at(-1), lookedUpTracks.at(-1));
    unmount();
});
