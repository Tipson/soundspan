import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

let capturedImageProps: Record<string, unknown> | null = null;
const noop = () => undefined;
const Icon = () => React.createElement("svg");

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) => {
        capturedImageProps = props;
        const { unoptimized: _unoptimized, ...imageProps } = props;
        return React.createElement("img", imageProps);
    },
});

mock.module("next/link", {
    defaultExport: ({ children, ...props }: Record<string, unknown>) =>
        React.createElement("a", props, children as React.ReactNode),
});

mock.module("next/navigation", {
    namedExports: {
        usePathname: () => "/",
        useRouter: () => ({ push: noop }),
    },
});

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: {
                id: "track-1",
                title: "Protected cover",
                artist: { name: "Artist" },
                album: { title: "Album", coverArt: "cover-1" },
            },
            currentAudiobook: null,
            currentPodcast: null,
            playbackType: "track",
            isShuffle: false,
            repeatMode: "off",
        }),
        usePlaybackStatus: () => ({ isPlaying: false, duration: 180 }),
        useAudioControls: () => ({
            pause: noop,
            resume: noop,
            next: noop,
            previous: noop,
            toggleShuffle: noop,
            toggleRepeat: noop,
            seek: noop,
        }),
    },
});

mock.module("@/lib/audio-playback-context", {
    namedExports: { usePlaybackProgress: () => ({ currentTime: 12 }) },
});

mock.module("@/lib/features-context", {
    namedExports: { useFeatures: () => ({ discovery: true }) },
});

mock.module("@/hooks/useTVNavigation", {
    namedExports: {
        useTVNavigation: () => ({
            containerRef: { current: null },
            focusFirstCard: noop,
            handleKeyDown: noop,
        }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: () => "/api/library/cover-art/cover-1?size=96",
            scanLibrary: async () => undefined,
        },
    },
});

mock.module("lucide-react", {
    namedExports: {
        RefreshCw: Icon,
        SkipBack: Icon,
        SkipForward: Icon,
        Shuffle: Icon,
        Repeat: Icon,
    },
});

test("TV now-playing renders protected cover art without the unauthenticated Next optimizer", async () => {
    const { TVLayout } = await import("../../components/layout/TVLayout");

    const html = renderToStaticMarkup(
        React.createElement(TVLayout, null, React.createElement("main")),
    );

    assert.match(html, /\/api\/library\/cover-art\/cover-1\?size=96/);
    assert.equal(capturedImageProps?.unoptimized, true);
});
