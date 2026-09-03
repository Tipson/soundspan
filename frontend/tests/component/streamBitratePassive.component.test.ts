import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React, { act } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const state = { isPlaying: false, isBuffering: true, streamProfile: null };
const calls: unknown[][] = [];
mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({
            playbackType: "track",
            currentTrack: {
                id: "yt-track",
                streamSource: "youtube",
                youtubeVideoId: "dQw4w9WgXcQ",
            },
        }),
        usePlaybackStatus: () => state,
    },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getYtMusicStreamInfo: async (...args: unknown[]) => {
                calls.push(args);
                return { abr: 128, acodec: "AAC" };
            },
        },
    },
});

test("quality reads wait for audio and use only cached provider metadata", async () => {
    const { useStreamBitrate } = await import("../../hooks/useStreamBitrate");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container);
    function Probe() {
        const value = useStreamBitrate();
        return React.createElement("span", null, value.bitrate);
    }
    try {
        await act(async () => root.render(React.createElement(Probe)));
        assert.equal(
            calls.length,
            0,
            "loading music must not start metadata work",
        );
        state.isPlaying = true;
        state.isBuffering = false;
        await act(async () => root.render(React.createElement(Probe)));
        assert.deepEqual(calls, [
            ["dQw4w9WgXcQ", undefined, { cachedOnly: true }],
        ]);
        assert.equal(container.textContent, "128");
    } finally {
        await act(async () => root.unmount());
        GlobalRegistrator.unregister();
    }
});
