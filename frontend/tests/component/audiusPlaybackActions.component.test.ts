import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Track } from "../../lib/audio-state-context";
import { toAudiusPlaybackTrack } from "../../lib/audio/audiusPlayback";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";
import { ru } from "../../lib/i18n/ru";

GlobalRegistrator.register({ url: "https://soundspan.test/queue" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());
const audius = toAudiusPlaybackTrack({
    source: "audius",
    id: "7AlA9",
    title: "Sinners",
    artist: "RAC",
    artistHandle: "RAC",
    artistVerified: true,
    durationSeconds: 237,
    attributionUrl: "https://audius.co/RAC/sinners",
    fullStreamAvailable: true,
    automaticFallbackEligible: false,
    downloadAllowed: false,
});
const local: Track = {
    id: "local-track",
    title: "Local song",
    duration: 200,
    artist: { name: "Artist" },
    album: { title: "Album" },
    filePath: "/library/local-fixture.mp3",
};
const youtube: Track = {
    id: "yt:abcdefghijk",
    title: "YouTube song",
    duration: 200,
    artist: { name: "Artist" },
    album: { title: "Album" },
    streamSource: "youtube",
    youtubeVideoId: "abcdefghijk",
};
let track = audius;
let preferenceQueries = 0;
let writes = 0;
let queued = 0;
const downloaded: unknown[] = [];
const noop = () => {};
const controls = {
    pause: noop,
    resume: noop,
    next: noop,
    previous: noop,
    seek: noop,
    setVolume: noop,
    toggleMute: noop,
    toggleShuffle: noop,
    toggleRepeat: noop,
    skipForward: noop,
    skipBackward: noop,
    returnToPreviousMode: noop,
    setPlayerMode: noop,
    advanceQueue: noop,
    removeFromQueue: noop,
    clearQueue: noop,
    playQueueIndex: noop,
    moveQueueItem: noop,
    playTrack: noop,
    playNext: () => {
        queued++;
    },
    addToQueue: () => {
        queued++;
    },
    setUpcoming: noop,
    startVibeMode: noop,
    stopVibeMode: noop,
};
const state = () => ({
    currentTrack: track,
    currentAudiobook: null,
    currentPodcast: null,
    playbackType: "track",
    queue: [track, track],
    currentIndex: 0,
    isShuffle: false,
    repeatMode: "off",
    vibeMode: false,
});
const status = () => ({
    isPlaying: false,
    isBuffering: false,
    duration: 237,
    playbackDuration: 237,
    currentTime: 0,
    canSeek: true,
    downloadProgress: null,
    audioError: null,
    clearAudioError: noop,
});
mock.module("@/lib/audio-state-context", {
    namedExports: { useAudioState: state },
});
mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: state,
        useAudioControls: () => controls,
        usePlaybackStatus: status,
    },
});
mock.module("@/lib/audio-controls-context", {
    namedExports: { useAudioControls: () => controls },
});
mock.module("@/lib/audio-playback-context", {
    namedExports: { usePlaybackStatus: status, usePlaybackProgress: status },
});
mock.module("@/lib/audio-volume-mode-context", {
    namedExports: {
        useAudioVolumeMode: () => ({
            volume: 1,
            isMuted: false,
            playerMode: "full",
        }),
    },
});
mock.module("@/components/player/hooks/useOverlayPlayerAudio", {
    namedExports: {
        useOverlayPlayerAudio: () => ({ ...state(), ...status(), ...controls }),
    },
});
mock.module("@/components/player/hooks/useOverlayGestures", {
    namedExports: {
        useOverlayGestures: () => ({
            swipeOffset: 0,
            overlayDragOffset: 0,
            drawerDragOffset: 0,
            overlayHeaderHandlers: {},
            drawerHandleHandlers: {},
            trackSwipeHandlers: {},
            resetDrawerDrag: noop,
        }),
    },
});
mock.module("@/hooks/useMediaQuery", {
    namedExports: { useIsMobile: () => true, useIsTablet: () => false },
});
mock.module("@/hooks/useMediaInfo", {
    namedExports: {
        useMediaInfo: () => ({
            title: track.title,
            subtitle: track.artist.name,
            coverUrl: null,
            artistLink: null,
            mediaLink: null,
            hasMedia: true,
        }),
    },
});
mock.module("@/hooks/useStreamBitrate", {
    namedExports: {
        useStreamBitrate: () => ({ qualityBadge: null }),
        resolvePlaybackQualityBadgeFromStreamSource: () => null,
    },
});
mock.module("@/hooks/useTrackPreference", {
    namedExports: {
        buildPreferenceMetadata: () => undefined,
        useTrackPreference: () => {
            preferenceQueries++;
            return {
                signal: "clear",
                isSaving: false,
                toggleLike: noop,
                toggleDislike: noop,
            };
        },
    },
});
mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => ({ vibeEmbeddings: false, loading: false }),
    },
});
mock.module("@/lib/listen-together-context", {
    namedExports: {
        useListenTogether: () => ({
            isInGroup: false,
            isHost: false,
            trackAvailability: new Map(),
        }),
    },
});
mock.module("@/lib/auth-context", {
    namedExports: { useAuth: () => ({ isAuthenticated: true }) },
});
mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({ toast: { success: noop, info: noop, error: noop } }),
    },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getMusicSourceStreamUrl: (provider: string, id: string) =>
                `/api/music-sources/recordings/${provider}/${id}/stream`,
            addTrackToPlaylist: async () => {
                writes++;
            },
            createPlaylist: async () => {
                writes++;
                return { id: "p" };
            },
        },
    },
});
mock.module("next/navigation", {
    namedExports: { useRouter: () => ({ push: noop }) },
});
mock.module("@/features/device-offline/DeviceOfflineProvider", {
    namedExports: {
        useOptionalDeviceOffline: () => ({
            recordForTrack: () => null,
            storage: { status: "ready" },
            download: async (input: unknown) => {
                writes++;
                downloaded.push(input);
                return { status: "ready" };
            },
        }),
    },
});

test("service catalog menu downloads an exact recording and does not offer unsupported playlist writes", async () => {
    const { createRoot } = await import("react-dom/client");
    const { TrackOverflowMenu } =
        await import("../../components/ui/TrackOverflowMenu");
    const value = toMusicSourcePlaybackTrack({
        provider: "vk",
        id: "1_2",
        title: "Song",
        artists: ["Artist"],
        duration: 180,
        contentVersion: "explicit",
        preview: false,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () =>
            root.render(
                React.createElement(TrackOverflowMenu, { track: value }),
            ),
        );
        await act(async () =>
            container
                .querySelector<HTMLButtonElement>(
                    'button[aria-haspopup="menu"]',
                )!
                .click(),
        );
        const buttons = [
            ...container.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]',
            ),
        ];
        assert.ok(
            !buttons.some(
                (button) => button.textContent === ru.trackMenu.addPlaylist,
            ),
        );
        const download = buttons.find(
            (button) => button.textContent === ru.trackMenu.download,
        );
        assert.ok(download);
        await act(async () => download.click());
        assert.deepEqual(JSON.parse(JSON.stringify(downloaded.at(-1))), {
            track: value,
            sourceUrl: "/api/music-sources/recordings/vk/1_2/stream",
            quality: "auto",
        });
    } finally {
        writes = 0;
        await act(async () => root.unmount());
        container.remove();
    }
});
mock.module("@/components/ui/PlaylistSelector", {
    namedExports: {
        PlaylistSelector: ({ isOpen }: { isOpen: boolean }) =>
            isOpen
                ? React.createElement("div", { "data-playlist-selector": true })
                : null,
    },
});
mock.module("@/components/ui/ShareLinkModal", {
    namedExports: { ShareLinkModal: () => null },
});
mock.module("@/components/player/SyncBadge", {
    namedExports: { SyncBadge: () => null },
});
mock.module("@/components/player/SeekSlider", {
    namedExports: { SeekSlider: () => null },
});
mock.module("@/components/player/overlay-tabs/OverlayQueueTab", {
    namedExports: { OverlayQueueTab: () => null },
});
mock.module("@/components/player/overlay-tabs/OverlayLyricsTab", {
    namedExports: { OverlayLyricsTab: () => null },
});
mock.module("@/components/player/overlay-tabs/OverlayRelatedTab", {
    namedExports: { OverlayRelatedTab: () => null },
});

for (const name of [
    "MiniPlayer",
    "FullPlayer",
    "OverlayPlayer",
    "QueuePage",
] as const) {
    test(`${name} hides Audius persistence controls without querying preferences; local/YouTube keep likes`, async () => {
        const Component =
            name === "QueuePage"
                ? (await import("../../app/queue/page")).default
                : name === "MiniPlayer"
                  ? (await import("../../components/player/MiniPlayer"))
                        .MiniPlayer
                  : name === "FullPlayer"
                    ? (await import("../../components/player/FullPlayer"))
                          .FullPlayer
                    : (await import("../../components/player/OverlayPlayer"))
                          .OverlayPlayer;
        track = audius;
        preferenceQueries = 0;
        const html = renderToStaticMarkup(React.createElement(Component));
        assert.doesNotMatch(
            html,
            /Оценка трека|Нравится|Не нравится|Добавить в плейлист|Сохранить как плейлист/,
        );
        assert.equal(preferenceQueries, 0);
        assert.match(
            html,
            /Воспроизвести|Слушать|Играть|Очистить|aria-label="Плей"|aria-label="Включить"|aria-label="Воспроизведение"|aria-label="Слушать"/,
        );
        for (const ordinary of [local, youtube]) {
            track = ordinary;
            assert.match(
                renderToStaticMarkup(React.createElement(Component)),
                /Нравится/,
            );
        }
    });
}

test("opened Audius overflow keeps queue actions and removal but hides playlist/download; other sources unchanged", async () => {
    const { createRoot } = await import("react-dom/client");
    const { TrackOverflowMenu, TrackMenuButton } =
        await import("../../components/ui/TrackOverflowMenu");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
        for (const value of [audius, local, youtube]) {
            await act(async () =>
                root.render(
                    React.createElement(TrackOverflowMenu, {
                        key: value.id,
                        track: value,
                        extraItemsAfter: React.createElement(TrackMenuButton, {
                            onClick: noop,
                            icon: null,
                            label: "Удалить из очереди",
                        }),
                    }),
                ),
            );
            await act(async () =>
                container
                    .querySelector<HTMLButtonElement>(
                        'button[aria-haspopup="menu"]',
                    )!
                    .click(),
            );
            const labels = [
                ...container.querySelectorAll('[role="menuitem"]'),
            ].map((item) => item.textContent);
            assert.ok(labels.includes(ru.trackMenu.playNext));
            assert.ok(labels.includes(ru.trackMenu.addQueue));
            assert.ok(labels.includes("Удалить из очереди"));
            assert.equal(
                labels.includes(ru.trackMenu.addPlaylist),
                value !== audius,
            );
            assert.equal(
                labels.includes(ru.trackMenu.download),
                value !== audius,
            );
            if (value === audius) {
                const attribution =
                    container.querySelector<HTMLAnchorElement>(
                        'a[role="menuitem"]',
                    );
                assert.ok(
                    attribution,
                    "the source page remains available from the queue",
                );
                assert.equal(attribution.href, "https://audius.co/RAC/sinners");
                assert.equal(attribution.target, "_blank");
                assert.equal(attribution.rel, "noopener noreferrer");
                assert.match(attribution.textContent, /Открыть в Audius/);
                const next = [
                    ...container.querySelectorAll<HTMLButtonElement>(
                        '[role="menuitem"]',
                    ),
                ].find((item) => item.textContent === ru.trackMenu.playNext)!;
                await act(async () => next.click());
                assert.equal(queued, 1);
                assert.equal(writes, 0);
            }
        }
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

test("Audius attribution rejects restored unsafe URLs and incidental metadata on other sources", async () => {
    const { createRoot } = await import("react-dom/client");
    const { TrackOverflowMenu } =
        await import("../../components/ui/TrackOverflowMenu");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const values = [
        { ...audius, sourcePageUrl: "javascript:alert(1)" },
        { ...audius, sourcePageUrl: "https://audius.co@evil.test/RAC/sinners" },
        {
            ...audius,
            sourcePageUrl: "https://audius.co/RAC/sinners?token=secret",
        },
        { ...audius, sourcePageUrl: "https://evil.test/RAC/sinners" },
        { ...youtube, sourcePageUrl: "https://audius.co/RAC/sinners" },
        { ...local, sourcePageUrl: "https://audius.co/RAC/sinners" },
    ];
    try {
        for (const [index, value] of values.entries()) {
            await act(async () =>
                root.render(
                    React.createElement(TrackOverflowMenu, {
                        key: index,
                        track: value,
                    }),
                ),
            );
            await act(async () =>
                container
                    .querySelector<HTMLButtonElement>(
                        'button[aria-haspopup="menu"]',
                    )!
                    .click(),
            );
            assert.equal(container.querySelector('a[role="menuitem"]'), null);
        }
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});
