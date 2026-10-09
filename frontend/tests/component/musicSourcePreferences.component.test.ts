import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Track } from "../../lib/audio-state-context";

let currentTrack: Track | null = null;
const queriedIds: Array<string | null | undefined> = [];
mock.module("@/hooks/useTrackPreference", {
    namedExports: {
        buildPreferenceMetadata: () => undefined,
        useTrackPreference: (id?: string | null) => {
            queriedIds.push(id);
            return {
                signal: "clear",
                isSaving: false,
                toggleLike: async () => undefined,
                toggleDislike: async () => undefined,
            };
        },
    },
});
mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack,
            currentAudiobook: null,
            currentPodcast: null,
            playbackType: "track",
        }),
        usePlaybackStatus: () => ({
            isPlaying: true,
            isBuffering: false,
            duration: 180,
            audioError: null,
            clearAudioError: () => undefined,
        }),
        useAudioControls: () => ({
            pause: () => undefined,
            resume: () => undefined,
            setPlayerMode: () => undefined,
        }),
    },
});
mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({ advanceQueue: () => undefined }),
    },
});
mock.module("@/lib/audio-playback-context", {
    namedExports: { usePlaybackProgress: () => ({ currentTime: 30 }) },
});
mock.module("@/hooks/useMediaQuery", {
    namedExports: { useIsMobile: () => true, useIsTablet: () => false },
});
mock.module("@/hooks/useMediaInfo", {
    namedExports: {
        useMediaInfo: () => ({
            title: "Song",
            subtitle: "Artist",
            coverUrl: null,
            hasMedia: true,
        }),
    },
});

for (const id of ["vk:-1_2", "yandex:0007"]) {
    test(`${id} shared preferences mount the exact query and both existing controls`, async () => {
        const { TrackPreferenceButtons } =
            await import("../../components/player/TrackPreferenceButtons");
        queriedIds.length = 0;
        const html = renderToStaticMarkup(
            React.createElement(TrackPreferenceButtons, {
                trackId: id,
                mode: "both",
            }),
        );
        assert.match(html, /aria-label="Нравится"/);
        assert.match(html, /aria-label="Не нравится"/);
        assert.deepEqual(queriedIds, [id]);
    });
    test(`${id} compact player keeps both feedback controls`, async () => {
        const { MiniPlayer } =
            await import("../../components/player/MiniPlayer");
        currentTrack = {
            id,
            title: "Song",
            artist: { name: "Artist" },
            album: { title: "" },
            duration: 180,
        };
        queriedIds.length = 0;
        const html = renderToStaticMarkup(React.createElement(MiniPlayer));
        assert.match(html, /aria-label="Нравится"/);
        assert.match(html, /aria-label="Не нравится"/);
        assert.deepEqual(queriedIds, [id]);
    });
}
for (const id of ["audius:abc", "vk:bad", "yandex:-9", "vk: 1_2"]) {
    test(`${id} unsupported controls do not mount a preference query`, async () => {
        const { TrackPreferenceButtons } =
            await import("../../components/player/TrackPreferenceButtons");
        queriedIds.length = 0;
        assert.equal(
            renderToStaticMarkup(
                React.createElement(TrackPreferenceButtons, {
                    trackId: id,
                    mode: "both",
                }),
            ),
            "",
        );
        assert.deepEqual(queriedIds, []);
    });
}
