import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";
import type { Track } from "../../lib/audio-state-context";

let current: Track;
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
        }) => React.createElement("div", null, betweenActions),
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
        assert.match(
            renderToStaticMarkup(React.createElement(OverlayPlayer)),
            /aria-label="Включить радио исполнителя"/,
        );
        current = { ...current, title: "Conflicting metadata" };
        assert.doesNotMatch(
            renderToStaticMarkup(React.createElement(OverlayPlayer)),
            /aria-label="Включить радио исполнителя"/,
        );
    });
}
