import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type MockLikedTrack = {
    id: string;
    title: string;
    duration: number;
    filePath: string | null;
    artist: {
        id: string;
        name: string;
    };
    album: {
        id: string;
        title: string;
        coverArt: string | null;
    };
    streamSource?: "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    source?: string;
    provider?: Record<string, unknown>;
};

type MockLikedPlaylistData = {
    playlist: {
        id: string;
        name: string;
    };
    tracks: MockLikedTrack[];
    total: number;
};

const state = {
    likedData: null as MockLikedPlaylistData | null,
    isLoading: false,
    isError: false,
    isPlaying: false,
    unlikePending: false,
    currentTrack: null as { id: string } | null,
};
const playlistAdds: Array<{
    playlistId: string;
    reference: Record<string, unknown>;
}> = [];

const icon = (name: string) => {
    const MockIcon = (props: Record<string, unknown> = {}) =>
        React.createElement("svg", { ...props, "data-icon": name });
    MockIcon.displayName = `MockIcon${name.replace(/[^a-zA-Z0-9]/g, "")}`;
    return MockIcon;
};

mock.module("lucide-react", {
    namedExports: {
        AudioLines: icon("audio-lines"),
        Heart: icon("heart"),
        ListMusic: icon("list-music"),
        Loader2: icon("loader-2"),
        Music: icon("music"),
        Pause: icon("pause"),
        Play: icon("play"),
        Plus: icon("plus"),
        Radio: icon("radio"),
        Shuffle: icon("shuffle"),
    },
});

mock.module("@/components/ui/CachedImage", {
    namedExports: {
        CachedImage: (props: Record<string, unknown>) =>
            React.createElement("img", {
                src: props.src as string,
                alt: props.alt as string,
            }),
    },
});

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: () => undefined,
            replace: () => undefined,
            back: () => undefined,
            prefetch: () => undefined,
        }),
        usePathname: () => "/playlist/my-liked",
        useSearchParams: () => new URLSearchParams(),
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", {
            src: props.src as string,
            alt: props.alt as string,
        }),
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: state.currentTrack,
        }),
    },
});

mock.module("@/hooks/useQueuedTrackIds", {
    namedExports: {
        useQueuedTrackIds: () => new Set<string>(),
    },
});

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: state.currentTrack,
        }),
        useAudioPlayback: () => {
            throw new Error(
                "my-liked must not subscribe to the composite playback " +
                    "context: it re-renders once per second during playback " +
                    "(GH #784). Use usePlaybackStatus instead.",
            );
        },
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

mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: false,
            trigger: () => undefined,
        }),
    },
});

mock.module("@/components/ui/PlaylistSelector", {
    namedExports: {
        PlaylistSelector: ({
            isOpen,
            onSelectPlaylist,
        }: {
            isOpen: boolean;
            onSelectPlaylist: (playlistId: string) => Promise<void>;
        }) =>
            isOpen
                ? React.createElement(
                      "button",
                      {
                          type: "button",
                          "data-testid": "select-target-playlist",
                          onClick: () => onSelectPlaylist("target-playlist"),
                      },
                      "Target playlist",
                  )
                : null,
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

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
            debug: () => undefined,
        },
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => url,
            getBrowseImageUrl: (url: string) => url,
            getTidalBrowseImageUrl: (url: string) => `tidal:${url}`,
            addTrackToPlaylist: async (
                playlistId: string,
                reference: Record<string, unknown>,
            ) => {
                playlistAdds.push({ playlistId, reference });
            },
            setTrackPreference: async () => ({
                trackId: "track-1",
                signal: "clear",
            }),
        },
    },
});

mock.module("@/hooks/useQueries", {
    namedExports: {
        queryKeys: {
            likedPlaylist: () => ["liked-playlist"],
        },
        useLikedPlaylistQuery: () => ({
            data: state.likedData,
            isLoading: state.isLoading,
            isError: state.isError,
        }),
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("@/utils/formatTime", {
    namedExports: {
        formatTime: (seconds: number) =>
            `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
    },
});

mock.module("@/utils/shuffle", {
    namedExports: {
        shuffleArray: <T>(arr: T[]) => arr,
    },
});

mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: {
        TrackPreferenceButtons: (props: {
            trackId?: string;
            mode?: string;
            signal?: string;
            resolveFromQuery?: boolean;
            buttonSizeClassName?: string;
            iconSizeClassName?: string;
        }) =>
            React.createElement("button", {
                type: "button",
                title: "Like",
                "data-testid": "liked-track-thumb",
                "data-track-id": props.trackId,
                "data-mode": props.mode,
                "data-signal": props.signal,
                "data-resolve-from-query": String(props.resolveFromQuery),
                "data-button-size": props.buttonSizeClassName,
                "data-icon-size": props.iconSizeClassName,
            }),
    },
});

mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: {
        TrackOverflowMenu: (props: {
            track?: { id?: string };
            showGoToArtist?: boolean;
            showGoToAlbum?: boolean;
            showMatchVibe?: boolean;
            showStartRadio?: boolean;
            showPlayNext?: boolean;
            showAddToQueue?: boolean;
            showAddToPlaylist?: boolean;
        }) =>
            React.createElement("div", {
                "data-testid": "overflow-menu",
                "data-track-id": props.track?.id,
                "data-show-go-to-artist": String(props.showGoToArtist ?? true),
                "data-show-start-radio": String(props.showStartRadio ?? true),
                "data-show-play-next": String(props.showPlayNext ?? true),
                "data-show-add-to-queue": String(props.showAddToQueue ?? true),
                "data-show-add-to-playlist": String(
                    props.showAddToPlaylist ?? true,
                ),
            }),
    },
});

mock.module("@/components/layout/PageHeader", {
    namedExports: {
        PageHeader: ({
            title,
            subtitle,
        }: {
            title: string;
            subtitle?: string;
        }) =>
            React.createElement(
                "div",
                { "data-testid": "page-header" },
                React.createElement("h1", null, title),
                subtitle ? React.createElement("p", null, subtitle) : null,
            ),
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                success: () => undefined,
                error: () => undefined,
            },
        }),
    },
});

function makeTrack(id: string, title: string): MockLikedTrack {
    return {
        id,
        title,
        duration: 180,
        filePath: null,
        artist: {
            id: "artist-1",
            name: "Test Artist",
        },
        album: {
            id: "album-1",
            title: "Test Album",
            coverArt: null,
        },
    };
}

function renderWithQueryClient(Component: React.ComponentType) {
    const queryClient = new QueryClient();

    return renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(Component),
        ),
    );
}

beforeEach(() => {
    playlistAdds.length = 0;
    state.likedData = {
        playlist: {
            id: "my-liked",
            name: "My Liked",
        },
        tracks: [],
        total: 0,
    };
    state.isLoading = false;
    state.isError = false;
    state.isPlaying = false;
    state.unlikePending = false;
    state.currentTrack = null;
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

test("renders empty-state copy and hides action buttons when there are no tracks", async () => {
    const mod = await import("../../app/playlist/my-liked/page");
    const MyLikedPlaylistPage = mod.default;

    const html = renderWithQueryClient(MyLikedPlaylistPage);

    assert.match(html, /<h1[^>]*>Любимые треки<\/h1>/);
    assert.doesNotMatch(html, />My Liked</);
    assert.match(html, /Любимых треков пока нет/);
    assert.match(html, /Нажмите на сердечко рядом с треком/);

    // Action buttons should be hidden when there are no tracks
    assert.doesNotMatch(html, /aria-label="Воспроизвести всё"/);
    assert.doesNotMatch(html, /title="Воспроизвести вперемешку/);
    assert.doesNotMatch(html, /title="Добавить всё в очередь/);
});

test("renders consolidated action bar buttons when tracks exist", async () => {
    state.likedData = {
        playlist: { id: "my-liked", name: "My Liked" },
        tracks: [makeTrack("track-1", "First"), makeTrack("track-2", "Second")],
        total: 2,
    };

    const mod = await import("../../app/playlist/my-liked/page");
    const html = renderWithQueryClient(mod.default);

    // Canonical order: Play, Shuffle, Add to Queue, Add to Playlist, Radio
    const rendered = document.createElement("div");
    rendered.innerHTML = html;
    const primary = rendered.querySelector(
        'button[aria-label="Воспроизвести всё"]',
    );
    assert.ok(
        primary,
        "the compact action retains its complete accessible name",
    );
    assert.equal(
        primary.querySelector('[data-playlist-primary-label="compact"]')
            ?.textContent,
        "Слушать",
    );
    assert.equal(
        primary.querySelector('[data-playlist-primary-label="full"]')
            ?.textContent,
        "Воспроизвести всё",
    );
    assert.match(html, /title="Воспроизвести вперемешку"/);
    assert.match(html, /title="Добавить всё в очередь"/);
    assert.match(html, /title="Добавить всё в плейлист"/);
    assert.match(html, /title="Запустить радио по плейлисту"/);
    const hero = html.match(
        /<header[^>]*data-music-detail="hero"[^>]*>[\s\S]*?<\/header>/,
    )?.[0];
    assert.ok(hero);
    assert.match(hero, /data-music-detail="actions"/);
    assert.match(hero, /data-detail-action-tier="primary"/);
    assert.match(hero, /data-detail-action-tier="secondary"/);
});

test("My Liked offers a manual device download for downloadable tracks only", async () => {
    state.likedData = {
        playlist: { id: "my-liked", name: "My Liked" },
        tracks: [
            {
                ...makeTrack("local-1", "Local"),
                source: "local",
            },
            {
                ...makeTrack("yt:video-1", "YouTube"),
                source: "youtube",
                streamSource: "youtube",
                youtubeVideoId: "video-1",
            },
            {
                ...makeTrack("peer-1", "Peer only"),
                source: "peer",
            },
            {
                ...makeTrack("tidal:991", "Historical TIDAL"),
                source: "tidal",
                streamSource: "tidal",
                tidalTrackId: 991,
            },
        ],
        total: 4,
    };

    const mod = await import("../../app/playlist/my-liked/page");
    const html = renderWithQueryClient(mod.default);

    assert.match(html, /data-testid="device-collection-download"/);
    assert.match(html, /data-collection-id="playlist:my-liked"/);
    assert.match(html, /data-collection-label="Любимые треки"/);
    assert.match(html, /data-track-ids="local-1,yt:video-1"/);
});

test("My Liked batch playlist add preserves actionable source identity", async () => {
    state.likedData = {
        playlist: { id: "my-liked", name: "My Liked" },
        tracks: [
            {
                ...makeTrack("local-stale", "Local stale"),
                filePath: "/music/local.flac",
                source: "tidal",
                streamSource: "tidal",
                tidalTrackId: 991,
            },
            {
                ...makeTrack("provider-youtube-row", "Provider YouTube"),
                provider: { youtubeVideoId: "provider-video" },
            },
            {
                ...makeTrack("tidal:992", "Source YouTube"),
                source: "youtube",
                youtubeVideoId: "source-video",
            },
            {
                ...makeTrack("tidal:993", "Historical TIDAL"),
                source: "tidal",
                streamSource: "tidal",
                tidalTrackId: 993,
            },
        ],
        total: 4,
    };

    const mod = await import("../../app/playlist/my-liked/page");
    const queryClient = new QueryClient();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(mod.default),
            ),
        );
    });

    const openSelector = container.querySelector(
        'button[title="Добавить всё в плейлист"]',
    ) as HTMLButtonElement | null;
    assert.ok(openSelector);
    await React.act(async () => openSelector.click());
    const selectPlaylist = container.querySelector(
        '[data-testid="select-target-playlist"]',
    ) as HTMLButtonElement | null;
    assert.ok(selectPlaylist);
    await React.act(async () => selectPlaylist.click());

    assert.deepEqual(playlistAdds, [
        {
            playlistId: "target-playlist",
            reference: { trackId: "local-stale" },
        },
        {
            playlistId: "target-playlist",
            reference: {
                youtubeVideoId: "provider-video",
                title: "Provider YouTube",
                artist: "Test Artist",
                album: "Test Album",
                duration: 180,
            },
        },
        {
            playlistId: "target-playlist",
            reference: {
                youtubeVideoId: "source-video",
                title: "Source YouTube",
                artist: "Test Artist",
                album: "Test Album",
                duration: 180,
            },
        },
    ]);

    await React.act(async () => root.unmount());
    container.remove();
});

test("shows Pause primary action and active like controls when a liked track is currently playing", async () => {
    state.likedData = {
        playlist: {
            id: "my-liked",
            name: "My Liked",
        },
        tracks: [
            makeTrack("track-1", "First Track"),
            makeTrack("track-2", "Second Track"),
        ],
        total: 2,
    };
    state.currentTrack = { id: "track-2" };
    state.isPlaying = true;

    const mod = await import("../../app/playlist/my-liked/page");
    const MyLikedPlaylistPage = mod.default;
    const html = renderWithQueryClient(MyLikedPlaylistPage);

    const rendered = document.createElement("div");
    rendered.innerHTML = html;
    const primary = rendered.querySelector('button[aria-label="Пауза"]');
    assert.ok(primary);
    assert.equal(
        primary.querySelector('[data-playlist-primary-label="compact"]')
            ?.textContent,
        "Пауза",
    );
    assert.equal(
        primary.querySelector('[data-playlist-primary-label="full"]')
            ?.textContent,
        "Пауза",
    );
    assert.match(html, /data-icon="pause"/);

    const thumbButtons = html.match(/data-testid="liked-track-thumb"/g) ?? [];
    assert.equal(
        thumbButtons.length,
        2,
        "expected one thumb control per liked track",
    );
    assert.match(html, /data-track-id="track-1"/);
    assert.match(html, /data-track-id="track-2"/);
    assert.match(html, /data-mode="up-only"/);
    assert.match(html, /data-signal="thumbs_up"/);
    assert.match(html, /data-resolve-from-query="false"/);
    assert.match(html, /data-button-size="h-11 w-11"/);
    assert.match(html, /data-icon-size="h-4 w-4"/);

    assert.doesNotMatch(html, /Delete Playlist/i);
});

test("overflow menu for remote liked tracks enables Go to Artist and Start Radio", async () => {
    const remoteTidalTrack: MockLikedTrack = {
        id: "tidal:991",
        title: "Remote Tidal Song",
        duration: 200,
        filePath: null,
        artist: { id: "remote-artist-cuid", name: "Tidal Artist" },
        album: {
            id: "remote-album-cuid",
            title: "Tidal Album",
            coverArt: null,
        },
        streamSource: "tidal",
        tidalTrackId: 991,
    };
    state.likedData = {
        playlist: { id: "my-liked", name: "My Liked" },
        tracks: [makeTrack("track-1", "Local Song"), remoteTidalTrack],
        total: 2,
    };

    const mod = await import("../../app/playlist/my-liked/page");
    const html = renderWithQueryClient(mod.default);

    // Both tracks should have overflow menus
    const menus = html.match(/data-testid="overflow-menu"/g) ?? [];
    assert.equal(menus.length, 2, "Expected 2 overflow menus (local + remote)");

    // The remote track's overflow menu should have showGoToArtist=true
    assert.match(
        html,
        /data-track-id="tidal:991"[^>]*data-show-go-to-artist="true"/,
        "Remote track overflow menu should enable Go to Artist",
    );
    assert.match(
        html,
        /data-track-id="tidal:991"[^>]*data-show-start-radio="true"/,
        "Remote track overflow menu should enable Start Radio",
    );
    assert.match(
        html,
        /data-track-id="tidal:991"[^>]*data-show-play-next="false"[^>]*data-show-add-to-queue="false"[^>]*data-show-add-to-playlist="false"/,
        "Historical TIDAL should keep safe navigation but expose no playback or playlist actions",
    );
});

test("resolveLikedTrackCoverUrl rejects retired provider artwork and keeps active sources", async () => {
    const { resolveLikedTrackCoverUrl } =
        await import("../../app/playlist/my-liked/page");

    const tidalTrack = {
        ...makeTrack("tidal-track", "Tidal Track"),
        streamSource: "tidal" as const,
        album: {
            id: "a1",
            title: "Album",
            coverArt: "https://img.tidal.com/cover.jpg",
        },
    };
    const ytTrack = {
        ...makeTrack("yt-track", "YT Track"),
        streamSource: "youtube" as const,
        album: {
            id: "a2",
            title: "Album",
            coverArt: "https://i.ytimg.com/cover.jpg",
        },
    };
    const localTrack = {
        ...makeTrack("local-track", "Local Track"),
        filePath: "/music/local.flac",
        streamSource: "tidal" as const,
        tidalTrackId: 993,
        album: { id: "a3", title: "Album", coverArt: "/cover/local.jpg" },
    };

    assert.equal(resolveLikedTrackCoverUrl(tidalTrack as any, 200), null);
    assert.equal(
        resolveLikedTrackCoverUrl(ytTrack as any, 200),
        "https://i.ytimg.com/cover.jpg",
    );
    assert.equal(
        resolveLikedTrackCoverUrl(localTrack as any, 200),
        "/cover/local.jpg",
    );
});
