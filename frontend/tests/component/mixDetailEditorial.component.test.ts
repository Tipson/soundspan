import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const tracks = [
    {
        id: "track-1",
        title: "Первый трек",
        duration: 180,
        albumId: "album-1",
        album: {
            title: "Альбом",
            coverUrl: null,
            artist: { id: "artist-1", name: "Исполнитель" },
        },
    },
    {
        id: "track-2",
        title: "Второй трек",
        duration: 200,
        albumId: "album-2",
        album: {
            title: "Другой альбом",
            coverUrl: null,
            artist: { id: "artist-2", name: "Исполнитель" },
        },
    },
];

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        Play: Icon,
        Pause: Icon,
        Music: Icon,
        Shuffle: Icon,
        Save: Icon,
        ListPlus: Icon,
        Loader2: Icon,
    },
});

mock.module("next/navigation", {
    namedExports: {
        useParams: () => ({ id: "mix-1" }),
        useRouter: () => ({ push: () => undefined }),
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
            getCoverArtUrl: (url: string) => url,
            saveMixAsPlaylist: async () => ({ id: "saved", name: "Saved" }),
        },
    },
});

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({ currentTrack: null }),
        usePlaybackStatus: () => ({ isPlaying: false }),
        useAudioControls: () => ({
            playTracks: () => undefined,
            addToQueue: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
        }),
    },
});

mock.module("@/components/ui/CoverMosaic", {
    namedExports: {
        CoverMosaic: () =>
            React.createElement("div", { "data-cover-mosaic": true }),
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: () => React.createElement("span", null, "spinner"),
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            success: () => undefined,
            info: () => undefined,
            error: () => undefined,
        },
    },
});

mock.module("@/hooks/useQueries", {
    namedExports: {
        useMixQuery: () => ({
            data: {
                id: "mix-1",
                name: "Микс для долгой дороги с очень длинным названием",
                description: "Спокойная последовательность без повторов",
                trackCount: tracks.length,
                coverUrls: [],
                tracks,
            },
            isLoading: false,
        }),
    },
});

mock.module("@/hooks/useQueuedTrackIds", {
    namedExports: {
        useQueuedTrackIds: () => new Set<string>(),
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

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => ({ autoPlaylists: true, loading: false }),
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
        },
    },
});

mock.module("@/components/track", {
    namedExports: {
        TrackList: () =>
            React.createElement("div", { "data-mix-track-list": true }),
        TrackListHeader: () => null,
    },
});

test("generated mix follows the editorial hero, action dock, and canonical TrackRow contract", async () => {
    const MixPage = (await import("../../app/mix/[id]/page")).default;
    const html = renderToStaticMarkup(React.createElement(MixPage));
    const hero = html.match(
        /<header[^>]*data-music-detail="hero"[\s\S]*?<\/header>/,
    )?.[0];

    assert.ok(hero);
    assert.match(hero, /data-music-detail="actions"/);
    assert.match(hero, /data-detail-action-tier="primary"/);
    assert.match(hero, /data-detail-action-tier="secondary"/);
    assert.match(hero, /Микс для долгой дороги/);
    assert.match(html, /data-music-detail="tracks"/);
    assert.match(html, /data-mix-track-list="true"/);

    for (const match of html.matchAll(/<button[^>]*>/g)) {
        assert.match(match[0], /(h-11 w-11|min-h-11)/);
    }
});
