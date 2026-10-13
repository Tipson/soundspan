import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";
import type { Track } from "../../lib/audio-state-context";

let current: Track;
let reduceMotion = false;
let artworkTransition: unknown;
mock.module("framer-motion", {
    namedExports: {
        useReducedMotion: () => reduceMotion,
        AnimatePresence: ({ children }: { children: React.ReactNode }) =>
            children,
        motion: {
            div: ({
                children,
                layoutId,
                transition,
                initial: _initial,
                animate: _animate,
                exit: _exit,
                ...props
            }: Record<string, unknown> & { children: React.ReactNode }) => {
                if (layoutId) artworkTransition = transition;
                return React.createElement("div", props, children);
            },
        },
    },
});
mock.module("@/components/player/hooks/useOverlayPlayerAudio", {
    namedExports: {
        useOverlayPlayerAudio: () => ({
            currentTrack: current,
            playbackType: "track",
            queue: [current],
            currentIndex: 0,
            currentTime: 12,
            playbackDuration: 180,
            canSeek: true,
        }),
    },
});
mock.module("@/hooks/useMediaQuery", {
    namedExports: { useIsMobile: () => true, useIsTablet: () => false },
});
mock.module("@/lib/listen-together-context", {
    namedExports: {
        useListenTogether: () => ({ isInGroup: false, isHost: false }),
    },
});
mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => ({ vibeEmbeddings: false, loading: false }),
    },
});
mock.module("@/hooks/useMediaInfo", {
    namedExports: {
        useMediaInfo: () => ({
            title: current.title,
            subtitle: current.artist.name,
        }),
    },
});
mock.module("@/components/player/CurrentTrackPreferenceButtons", {
    namedExports: {
        CurrentTrackPreferenceButtons: ({
            betweenActions,
        }: {
            betweenActions: React.ReactNode;
        }) =>
            React.createElement(
                "div",
                null,
                React.createElement("button", { "aria-label": "Нравится" }),
                betweenActions,
                React.createElement("button", { "aria-label": "Не нравится" }),
            ),
    },
});
mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: { TrackOverflowMenu: () => null },
});
mock.module("@/components/player/SyncBadge", {
    namedExports: { SyncBadge: () => null },
});
mock.module("@/components/player/PlaybackReport", {
    namedExports: { PlaybackReport: () => null },
});

for (const provider of ["vk", "yandex"] as const) {
    test(`${provider} overlay exposes track radio without an artist ID`, async () => {
        current = toMusicSourcePlaybackTrack({
            provider,
            id: provider === "vk" ? "-001_002" : "0007",
            title: "Song",
            artists: ["First", "Guest"],
            duration: 180,
            contentVersion: "unknown",
            preview: false,
        });
        const { OverlayPlayer } =
            await import("../../components/player/OverlayPlayer");
        assert.equal(current.artist.id, undefined);
        const html = renderToStaticMarkup(React.createElement(OverlayPlayer));
        assert.match(html, /aria-label="Включить радио исполнителя"/);
        const playIndex = html.indexOf('aria-label="Воспроизвести"');
        const likeIndex = html.indexOf('aria-label="Нравится"');
        const radioIndex = html.indexOf(
            'aria-label="Включить радио исполнителя"',
        );
        const dislikeIndex = html.indexOf('aria-label="Не нравится"');
        assert.ok(playIndex >= 0 && likeIndex >= 0 && dislikeIndex >= 0);
        assert.ok(
            playIndex < likeIndex &&
                likeIndex < radioIndex &&
                radioIndex < dislikeIndex,
            "mobile playback precedes the like, radio, dislike group",
        );
        reduceMotion = true;
        renderToStaticMarkup(React.createElement(OverlayPlayer));
        assert.deepEqual(artworkTransition, { duration: 0 });
        reduceMotion = false;
        current = { ...current, title: "Conflicting metadata" };
        assert.doesNotMatch(
            renderToStaticMarkup(React.createElement(OverlayPlayer)),
            /aria-label="Включить радио исполнителя"/,
        );
    });
}
