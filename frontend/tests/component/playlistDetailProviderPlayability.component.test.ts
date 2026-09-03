import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = {
    isLoading: false,
    queuedTrackIds: new Set<string>(),
    currentTrack: null as { id: string } | null,
    isPlaying: false,
    playlist: null as Record<string, unknown> | null,
    routerPushPath: null as string | null,
    preferenceProps: [] as Array<{
        trackId?: string;
        mode?: string;
        buttonSizeClassName?: string;
        metadata?: {
            title?: string;
            artist?: string;
            album?: string;
            duration?: number;
        };
    }>,
};

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        Play: Icon,
        Pause: Icon,
        Trash2: Icon,
        Shuffle: Icon,
        Eye: Icon,
        EyeOff: Icon,
        Ellipsis: Icon,
        ListMusic: Icon,
        Music: Icon,
        Volume2: Icon,
        RefreshCw: Icon,
        AlertCircle: Icon,
        X: Icon,
        Loader2: Icon,
        Radio: Icon,
        Heart: Icon,
        Plus: Icon,
        Globe: Icon,
        GlobeLock: Icon,
        Pencil: Icon,
        Share2: Icon,
        GripVertical: Icon,
        ArrowUp: Icon,
        ArrowDown: Icon,
        ArrowUpToLine: Icon,
        AudioLines: Icon,
        ListPlus: Icon,
    },
});

mock.module("next/navigation", {
    namedExports: {
        useParams: () => ({ id: "playlist-1" }),
        useRouter: () => ({
            push: (path: string) => {
                state.routerPushPath = path;
            },
        }),
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", {
            src: props.src as string,
            alt: props.alt as string,
        }),
});

mock.module("@/components/ui/ConfirmDialog", {
    namedExports: {
        ConfirmDialog: () => null,
    },
});

mock.module("@/components/ui/ShareLinkModal", {
    namedExports: {
        ShareLinkModal: () => null,
    },
});

mock.module(
    "@/features/device-offline/components/DeviceCollectionDownloadButton",
    {
        namedExports: {
            DeviceCollectionDownloadButton: ({
                tracks,
                collectionId,
                collectionLabel,
            }: {
                tracks: Array<{ id: string }>;
                collectionId: string;
                collectionLabel: string;
            }) =>
                React.createElement("button", {
                    type: "button",
                    "data-testid": "device-collection-download",
                    "data-collection-id": collectionId,
                    "data-collection-label": collectionLabel,
                    "data-track-ids": tracks.map((track) => track.id).join(","),
                }),
        },
    },
);

mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: {
        TrackPreferenceButtons: (props: {
            trackId?: string;
            mode?: string;
            buttonSizeClassName?: string;
            metadata?: {
                title?: string;
                artist?: string;
                album?: string;
                duration?: number;
            };
        }) => {
            state.preferenceProps.push(props);
            return React.createElement(
                "button",
                { type: "button", "data-preference-mode": props.mode },
                "prefs",
            );
        },
    },
});

mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: {
        TrackOverflowMenu: () =>
            React.createElement(
                "button",
                { type: "button", "aria-label": "Track actions" },
                "actions",
            ),
        TrackMenuButton: ({ label }: { label: string }) =>
            React.createElement("span", null, label),
    },
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: {
        TidalBadge: () => React.createElement("span", null, "TIDAL"),
    },
});

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: {
        YouTubeBadge: () => React.createElement("span", null, "YOUTUBE"),
    },
});

mock.module("@/hooks/useQueries", {
    namedExports: {
        usePlaylistQuery: () => ({
            data: state.playlist,
            isLoading: state.isLoading,
        }),
        usePlaylistPagesQuery: () => ({
            data: state.playlist ? { pages: [state.playlist] } : undefined,
            isLoading: state.isLoading,
            hasNextPage: false,
            isFetchingNextPage: false,
            isFetchNextPageError: false,
            fetchNextPage: async () => undefined,
        }),
    },
});

mock.module("@/hooks/useQueuedTrackIds", {
    namedExports: {
        useQueuedTrackIds: () => state.queuedTrackIds,
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: state.currentTrack,
        }),
    },
});

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: state.currentTrack,
        }),
        useAudioPlayback: () => ({
            isPlaying: state.isPlaying,
        }),
        usePlaybackStatus: () => ({
            isPlaying: state.isPlaying,
        }),
        useAudioControls: () => ({
            playTracks: () => undefined,
            playNow: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
            addTracksToQueue: () => undefined,
        }),
    },
});

mock.module("@/hooks/useCollectionLikeAll", {
    namedExports: {
        useCollectionLikeAll: () => ({
            isAllLiked: false,
            isApplying: false,
            toggleLikeAll: async () => undefined,
        }),
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                error: () => undefined,
                success: () => undefined,
                info: () => undefined,
            },
        }),
    },
});

mock.module("@/lib/download-context", {
    namedExports: {
        useDownloadContext: () => ({
            downloadsEnabled: true,
        }),
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: () => React.createElement("div", null, "Loading"),
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

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => url,
            getRadioTracks: async () => ({ tracks: [] }),
            removeTrackFromPlaylist: async () => undefined,
            deletePlaylist: async () => undefined,
            hidePlaylist: async () => undefined,
            unhidePlaylist: async () => undefined,
            getFreshPreviewUrl: async () => ({
                previewUrl: "https://preview.local",
            }),
            retryPendingTrack: async () => ({ success: true }),
            removePendingTrack: async () => undefined,
        },
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("@/utils/shuffle", {
    namedExports: {
        shuffleArray: <T>(arr: T[]) => arr,
    },
});

mock.module("@/utils/formatTime", {
    namedExports: {
        formatTime: (seconds: number) =>
            `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
            warn: () => undefined,
            info: () => undefined,
            debug: () => undefined,
        },
    },
});

beforeEach(() => {
    state.isLoading = false;
    state.currentTrack = null;
    state.isPlaying = false;
    state.queuedTrackIds = new Set();
    state.routerPushPath = null;
    state.preferenceProps = [];
    state.playlist = {
        id: "playlist-1",
        name: "Mixed Playlist",
        isOwner: true,
        isHidden: false,
        pendingCount: 0,
        pendingTracks: [],
        items: [
            {
                id: "local-1",
                type: "track",
                sort: 1,
                trackId: "track-local-1",
                provider: { source: "local", label: "LOCAL" },
                playback: { isPlayable: true, reason: null, message: null },
                track: {
                    id: "track-local-1",
                    title: "Local Song",
                    duration: 180,
                    album: {
                        id: "album-1",
                        title: "Local Album",
                        coverArt: null,
                        artist: { id: "artist-1", name: "Local Artist" },
                    },
                },
            },
            {
                id: "tidal-1",
                type: "track",
                sort: 2,
                provider: {
                    source: "tidal",
                    label: "TIDAL",
                    tidalTrackId: 991,
                },
                playback: { isPlayable: true, reason: null, message: null },
                track: {
                    id: "tidal:991",
                    title: "Tidal Song",
                    duration: 245,
                    streamSource: "tidal",
                    tidalTrackId: 991,
                    album: {
                        title: "Tidal Album",
                        coverArt: null,
                        artist: { name: "Tidal Artist" },
                    },
                },
            },
            {
                id: "yt-1",
                type: "track",
                sort: 3,
                provider: {
                    source: "youtube",
                    label: "YOUTUBE",
                    youtubeVideoId: "yt-video-7",
                },
                playback: { isPlayable: true, reason: null, message: null },
                track: {
                    id: "yt:yt-video-7",
                    title: "YouTube Song",
                    duration: 210,
                    streamSource: "youtube",
                    youtubeVideoId: "yt-video-7",
                    album: {
                        title: "YT Album",
                        coverArt: null,
                        artist: { name: "YT Artist" },
                    },
                },
            },
            {
                id: "missing-1",
                type: "track",
                sort: 4,
                provider: { source: "unknown", label: "UNKNOWN" },
                playback: {
                    isPlayable: false,
                    reason: "missing_provider_track",
                    message: "Track mapping missing for this import.",
                },
                track: null,
            },
        ],
        mergedItems: [
            {
                id: "local-1",
                type: "track",
                sort: 1,
                trackId: "track-local-1",
                provider: { source: "local", label: "LOCAL" },
                playback: { isPlayable: true, reason: null, message: null },
                track: {
                    id: "track-local-1",
                    title: "Local Song",
                    duration: 180,
                    album: {
                        id: "album-1",
                        title: "Local Album",
                        coverArt: null,
                        artist: { id: "artist-1", name: "Local Artist" },
                    },
                },
            },
            {
                id: "tidal-1",
                type: "track",
                sort: 2,
                provider: {
                    source: "tidal",
                    label: "TIDAL",
                    tidalTrackId: 991,
                },
                playback: { isPlayable: true, reason: null, message: null },
                track: {
                    id: "tidal:991",
                    title: "Tidal Song",
                    duration: 245,
                    streamSource: "tidal",
                    tidalTrackId: 991,
                    album: {
                        title: "Tidal Album",
                        coverArt: null,
                        artist: { name: "Tidal Artist" },
                    },
                },
            },
            {
                id: "yt-1",
                type: "track",
                sort: 3,
                provider: {
                    source: "youtube",
                    label: "YOUTUBE",
                    youtubeVideoId: "yt-video-7",
                },
                playback: { isPlayable: true, reason: null, message: null },
                track: {
                    id: "yt:yt-video-7",
                    title: "YouTube Song",
                    duration: 210,
                    streamSource: "youtube",
                    youtubeVideoId: "yt-video-7",
                    album: {
                        title: "YT Album",
                        coverArt: null,
                        artist: { name: "YT Artist" },
                    },
                },
            },
            {
                id: "missing-1",
                type: "track",
                sort: 4,
                provider: { source: "unknown", label: "UNKNOWN" },
                playback: {
                    isPlayable: false,
                    reason: "missing_provider_track",
                    message: "Track mapping missing for this import.",
                },
                track: null,
            },
        ],
    };
});

test("playlist detail renders consolidated action bar buttons", async () => {
    const mod = await import("../../app/playlist/[id]/page");
    const PlaylistDetailPage = mod.default;

    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(PlaylistDetailPage),
        ),
    );

    // Canonical order: Play, Shuffle, Add to Queue, Like All, Radio
    assert.match(html, /<span>Воспроизвести всё<\/span>/);
    assert.match(html, /title="Воспроизвести вперемешку"/);
    assert.match(html, /title="Добавить всё в очередь"/);
    assert.match(html, /title="Добавить все треки в любимые"/);
    assert.match(html, /title="Запустить радио по плейлисту"/);
    const hero = html.match(
        /<header[^>]*data-music-detail="hero"[^>]*>[\s\S]*?<\/header>/,
    )?.[0];
    assert.ok(hero);
    assert.match(hero, /data-music-detail="actions"/);
    assert.match(hero, /data-detail-action-tier="primary"/);
    assert.match(hero, /data-detail-action-tier="secondary"/);
});

test("playlist detail offers a device download for playable tracks only", async () => {
    const mod = await import("../../app/playlist/[id]/page");
    const PlaylistDetailPage = mod.default;
    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(PlaylistDetailPage),
        ),
    );

    assert.match(html, /data-testid="device-collection-download"/);
    assert.match(html, /data-collection-id="playlist:playlist-1"/);
    assert.match(html, /data-collection-label="Mixed Playlist"/);
    assert.match(
        html,
        /data-track-ids="track-local-1,tidal:991,yt:yt-video-7"/,
    );
});

test("generated radio playlist detail adds append and regenerate actions", async () => {
    const playlist = state.playlist;
    assert.ok(playlist);
    state.playlist = {
        ...playlist,
        mixId: "radio-ephemeral:genre:rock",
    };
    const mod = await import("../../app/playlist/[id]/page");
    const PlaylistDetailPage = mod.default;
    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(PlaylistDetailPage),
        ),
    );

    assert.match(html, /Добавить ещё треки/);
    assert.match(html, /Собрать заново/);
});

test("playlist detail renders overflow menu for remote tracks (tidal + youtube)", async () => {
    const mod = await import("../../app/playlist/[id]/page");
    const PlaylistDetailPage = mod.default;

    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(PlaylistDetailPage),
        ),
    );

    // The mock TrackOverflowMenu renders <button aria-label="Track actions">actions</button>.
    // We expect 3 overflow menus: one for local, one for tidal, one for youtube.
    // The unplayable/missing track should NOT get an overflow menu.
    const overflowCount = (html.match(/aria-label="Track actions"/g) || [])
        .length;
    assert.equal(
        overflowCount,
        3,
        `Expected 3 overflow menus (local + tidal + youtube), got ${overflowCount}`,
    );
});

test("playlist rows keep the compact like-only preference control", async () => {
    const mod = await import("../../app/playlist/[id]/page");
    const PlaylistDetailPage = mod.default;

    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(PlaylistDetailPage),
        ),
    );

    const compactPreferenceCount = (
        html.match(/data-preference-mode="up-only"/g) ?? []
    ).length;
    assert.equal(compactPreferenceCount, 3);
    assert.doesNotMatch(html, /data-preference-mode="both"/);
    assert.deepEqual(
        state.preferenceProps.map(
            ({ buttonSizeClassName }) => buttonSizeClassName,
        ),
        ["h-11 w-11", "h-11 w-11", "h-11 w-11"],
    );
    assert.deepEqual(
        state.preferenceProps.map(({ trackId, metadata }) => ({
            trackId,
            metadata,
        })),
        [
            { trackId: "track-local-1", metadata: undefined },
            {
                trackId: "tidal:991",
                metadata: {
                    title: "Tidal Song",
                    artist: "Tidal Artist",
                    album: "Tidal Album",
                    duration: 245,
                    thumbnailUrl: undefined,
                },
            },
            {
                trackId: "yt:yt-video-7",
                metadata: {
                    title: "YouTube Song",
                    artist: "YT Artist",
                    album: "YT Album",
                    duration: 210,
                    thumbnailUrl: undefined,
                },
            },
        ],
    );
});

test("pending playlist rows expose named 44px recovery controls", async () => {
    const playlist = state.playlist;
    assert.ok(playlist);
    state.playlist = {
        ...playlist,
        pendingCount: 1,
        pendingTracks: [
            {
                pending: {
                    id: "pending-1",
                    title: "Missing Song",
                    artist: "Missing Artist",
                    album: "Missing Album",
                },
            },
        ],
    };

    const mod = await import("../../app/playlist/[id]/page");
    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(mod.default),
        ),
    );

    for (const label of [
        "Воспроизвести фрагмент «Missing Song»",
        "Повторить загрузку «Missing Song»",
        "Удалить недоступный трек «Missing Song»",
    ]) {
        const button = html.match(
            new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`),
        )?.[0];
        assert.ok(button, `missing ${label}`);
        assert.match(button, /h-11 w-11/);
    }
});

test("playlist detail renders provider badges and unplayable fallback messaging", async () => {
    const mod = await import("../../app/playlist/[id]/page");
    const PlaylistDetailPage = mod.default;

    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(PlaylistDetailPage),
        ),
    );

    assert.doesNotMatch(html, /1 local \/ 1 TIDAL \/ 1 YouTube/);
    assert.match(html, /Local Song/);
    assert.match(html, /TIDAL/);
    assert.match(html, /YOUTUBE/);
    assert.match(html, /НЕДОСТУПНО/);
    assert.match(html, /Сейчас этот трек недоступен для воспроизведения\./);
    assert.match(html, /Сейчас недоступно/);
    assert.match(html, /Недоступно для воспроизведения/);
    assert.match(html, /title="Удалить из плейлиста"/);
});

test("playlist detail distinguishes removed tracks without changing missing-provider treatment", async () => {
    const playlist = state.playlist;
    assert.ok(playlist);
    const items = playlist.items;
    assert.ok(Array.isArray(items));
    state.playlist = {
        ...playlist,
        items: [
            ...items,
            {
                id: "removed-1",
                type: "track",
                sort: 5,
                trackId: "track-removed-1",
                provider: { source: "local", label: "LOCAL" },
                playback: {
                    isPlayable: false,
                    reason: "track_removed",
                    message:
                        "Playback is unavailable because this track was removed from the library.",
                },
                track: {
                    id: "track-removed-1",
                    title: "Removed Song",
                    duration: 200,
                    album: {
                        id: "album-removed",
                        title: "Removed Album",
                        coverArt: null,
                        artist: {
                            id: "artist-removed",
                            name: "Removed Artist",
                        },
                    },
                },
            },
        ],
    };

    const mod = await import("../../app/playlist/[id]/page");
    const PlaylistDetailPage = mod.default;
    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(PlaylistDetailPage),
        ),
    );

    assert.match(html, /Removed Song/);
    assert.match(html, /УДАЛЁН/);
    assert.match(
        html,
        /title="Файл удалён из медиатеки — восстановите его, чтобы вернуть трек"/,
    );
    assert.match(html, /opacity-60/);
    assert.match(html, /НЕДОСТУПНО/);
    assert.match(html, /Сейчас этот трек недоступен для воспроизведения\./);
});
