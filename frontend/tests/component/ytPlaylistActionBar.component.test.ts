import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = {
    isLoading: false,
    error: null as string | null,
    playlist: null as Record<string, unknown> | null,
    currentTrack: null as { id: string } | null,
    isPlaying: false,
    isAllLiked: false,
    isApplyingLikeAll: false,
};

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        ArrowLeft: Icon,
        Play: Icon,
        Pause: Icon,
        Music2: Icon,
        ListMusic: Icon,
        Shuffle: Icon,
        Plus: Icon,
        Heart: Icon,
        Loader2: Icon,
    },
});

mock.module("next/navigation", {
    namedExports: {
        useParams: () => ({ id: "PLtest123" }),
        useRouter: () => ({
            push: () => undefined,
            back: () => undefined,
        }),
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

mock.module("@/lib/api", {
    namedExports: {
        api: {
            get: async () => state.playlist,
            getCoverArtUrl: (url: string) => url,
            getBrowseImageUrl: (url: string) => url,
            getYtMusicSong: async () => ({}),
            addTrackToPlaylist: async () => undefined,
        },
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                success: () => undefined,
                error: () => undefined,
                info: () => undefined,
            },
        }),
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: () => React.createElement("span", null, "loading"),
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: state.currentTrack,
        }),
    },
});

mock.module("@/lib/audio-playback-context", {
    namedExports: {
        useAudioPlayback: () => ({
            isPlaying: state.isPlaying,
        }),
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: () => undefined,
            playNow: () => undefined,
            addTracksToQueue: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
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

mock.module("@/hooks/useCollectionLikeAll", {
    namedExports: {
        useCollectionLikeAll: () => ({
            isAllLiked: state.isAllLiked,
            isApplying: state.isApplyingLikeAll,
            toggleLikeAll: async () => undefined,
        }),
    },
});

mock.module("@/components/ui/PlaylistSelector", {
    namedExports: {
        PlaylistSelector: () => null,
    },
});

mock.module("@/features/library/components/SaveMusicEntityButton", {
    namedExports: {
        SaveMusicEntityButton: () =>
            React.createElement("button", { className: "min-h-11" }, "save"),
    },
});

mock.module(
    "@/features/device-offline/components/DeviceCollectionDownloadButton",
    {
        namedExports: {
            DeviceCollectionDownloadButton: () =>
                React.createElement(
                    "button",
                    { className: "min-h-11" },
                    "download",
                ),
        },
    },
);

mock.module("@/lib/trackRef", {
    namedExports: {
        toAddToPlaylistRef: (track: Record<string, unknown>) => track,
    },
});

mock.module("@/utils/shuffle", {
    namedExports: {
        shuffleArray: <T>(arr: T[]) => arr,
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
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

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: {
        YouTubeBadge: () => React.createElement("span", null, "YT"),
    },
});

mock.module("@/components/track", {
    namedExports: {
        TrackList: () => React.createElement("div", null, "track-list"),
        TrackListHeader: () =>
            React.createElement("div", null, "track-list-header"),
    },
});

function makePlaylist(trackCount = 3) {
    return {
        id: "PLtest123",
        title: "Test YT Playlist",
        description: "A test playlist",
        trackCount,
        thumbnailUrl: "https://img.youtube.com/thumb.jpg",
        tracks: Array.from({ length: trackCount }, (_, i) => ({
            videoId: `vid-${i + 1}`,
            title: `Track ${i + 1}`,
            artist: `Artist ${i + 1}`,
            artists: [`Artist ${i + 1}`],
            album: `Album ${i + 1}`,
            duration: 200 + i * 10,
            thumbnailUrl: null,
        })),
        source: "ytmusic",
    };
}

async function renderPage() {
    // We need to render the inner content component, but the default export
    // wraps it in Suspense. For SSR with renderToStaticMarkup, Suspense
    // renders the fallback unless we render the inner content directly.
    // Since the page does an async fetch in useEffect (which won't run in SSR),
    // and initially isLoading=true, it will show the loading spinner.
    // We need to set isLoading=false and provide playlist data via state.
    // However, the page manages its own state internally via useState+useEffect.
    // For this test, we mock the api.get to return our playlist, but useEffect
    // doesn't run in renderToStaticMarkup. The initial state has isLoading=true.
    // So the SSR output will always be the loading spinner from Suspense.
    //
    // Instead, let's test the component renders by checking what we can.
    // The page uses useState(true) for isLoading, so SSR will always show spinner.
    // This is a limitation of testing stateful components with renderToStaticMarkup.
    //
    // We'll test what we can: the loading state renders, and also test the
    // DiscoverActionBar-style isolated rendering approach isn't possible here
    // because the buttons are inline in the page component.
    //
    // For meaningful button tests, we need the component to be in a loaded state.
    // Since useEffect doesn't fire during SSR, we should mock useState to
    // provide pre-loaded state. But that's fragile.
    //
    // Better approach: Since the inner component is not exported, and the default
    // export wraps in Suspense, SSR will show the fallback. Let's verify the
    // loading state works and write a note about the limitation.

    const queryClient = new QueryClient();
    const mod = await import("../../app/explore/yt-playlist/[id]/page");
    const Page = mod.default;
    return renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(Page),
        ),
    );
}

beforeEach(() => {
    state.isLoading = false;
    state.error = null;
    state.playlist = makePlaylist();
    state.currentTrack = null;
    state.isPlaying = false;
    state.isAllLiked = false;
    state.isApplyingLikeAll = false;
});

test("yt-playlist page explains the initial loading state in Russian", async () => {
    // Since the page uses useEffect for data fetching and renderToStaticMarkup
    // doesn't execute effects, the component will render in its initial isLoading=true state.
    const html = await renderPage();

    assert.match(html, /Загружаем плейлист/);
});

test("yt-playlist loaded view uses editorial hero, action hierarchy, and canonical track surface", async () => {
    const mod = await import("../../app/explore/yt-playlist/[id]/page");
    const ActionDock = (
        mod as unknown as {
            YtPlaylistActionDock: React.ComponentType<Record<string, unknown>>;
        }
    ).YtPlaylistActionDock;
    const EditorialSurface = (
        mod as unknown as {
            YtPlaylistEditorialSurface: React.ComponentType<
                Record<string, unknown>
            >;
        }
    ).YtPlaylistEditorialSurface;
    assert.equal(typeof ActionDock, "function");
    assert.equal(typeof EditorialSurface, "function");

    const playlist = makePlaylist() as Record<string, unknown>;
    playlist.title =
        "Очень длинное название плейлиста YouTube Music для узкого экрана";
    const actions = React.createElement(ActionDock, {
        tracks: playlist.tracks,
        collectionId: playlist.id,
        collectionLabel: playlist.title,
        isAlbumType: false,
        providerAlbumEntity: null,
        isThisPlaylistPlaying: false,
        isPlaying: false,
        showPlaySpinner: false,
        likeableTrackCount: 3,
        isAllLiked: false,
        isApplyingLikeAll: false,
        onTogglePlay: () => undefined,
        onShuffle: () => undefined,
        onAddToQueue: () => undefined,
        onAddToPlaylist: () => undefined,
        onToggleLikeAll: () => undefined,
        onBack: () => undefined,
    });
    const html = renderToStaticMarkup(
        React.createElement(EditorialSurface, {
            playlist,
            isAlbumType: false,
            totalDuration: 630,
            actions,
            onPlayTrack: () => undefined,
        }),
    );
    const hero = html.match(
        /<header[^>]*data-music-detail="hero"[\s\S]*?<\/header>/,
    )?.[0];

    assert.ok(hero);
    assert.match(hero, /data-music-detail="actions"/);
    assert.match(hero, /data-detail-action-tier="primary"/);
    assert.match(hero, /data-detail-action-tier="secondary"/);
    assert.match(hero, /Очень длинное название плейлиста YouTube Music/);
    assert.match(html, /data-music-detail="tracks"/);
    assert.match(html, /track-list/);

    for (const match of hero.matchAll(/<button[^>]*>/g)) {
        assert.match(match[0], /(h-11 w-11|min-h-11)/);
    }
});
