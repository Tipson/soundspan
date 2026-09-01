import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
    playbackType: "track" as "track" | null,
    advanceOrigins: [] as string[],
    dislikeAppliedCallbacks: [] as Array<(trackId: string) => void>,
};

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({ playbackType: state.playbackType }),
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            pause: () => undefined,
            play: () => undefined,
            advanceQueue: (origin: string) => state.advanceOrigins.push(origin),
        }),
    },
});

mock.module("@/lib/audio-playback-context", {
    namedExports: {
        usePlaybackStatus: () => ({ isPlaying: true, duration: 180 }),
        usePlaybackProgress: () => ({ currentTime: 30 }),
    },
});

mock.module("@/hooks/useTrackPreference", {
    namedExports: {
        buildPreferenceMetadata: () => undefined,
    },
});

mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: {
        TrackPreferenceButtons: ({
            mode,
            buttonSizeClassName,
            onThumbsDownApplied,
        }: {
            mode?: string;
            buttonSizeClassName?: string;
            onThumbsDownApplied?: (trackId: string) => void;
        }) => {
            if (onThumbsDownApplied) {
                state.dislikeAppliedCallbacks.push(onThumbsDownApplied);
            }
            return React.createElement("button", {
                type: "button",
                "aria-label": "Apply dislike",
                "data-preference-mode": mode,
                "data-button-size": buttonSizeClassName,
            });
        },
    },
});

beforeEach(() => {
    state.playbackType = "track";
    state.advanceOrigins.length = 0;
    state.dislikeAppliedCallbacks.length = 0;
});

afterEach(() => {
    document.body.innerHTML = "";
});

mock.module("../../components/vibe/NowPlayingCard", {
    namedExports: {
        NowPlayingCard: ({ likeSlot }: { likeSlot?: React.ReactNode }) =>
            React.createElement("div", null, likeSlot),
    },
});

test("Vibe now-playing exposes touch-sized like and dislike controls", async () => {
    const { NowPlayingConnected } =
        await import("../../components/vibe/NowPlayingConnected");
    const html = renderToStaticMarkup(
        React.createElement(NowPlayingConnected, {
            track: {
                id: "yt:vibe-track",
                title: "Vibe Track",
                duration: 180,
                artist: { name: "Vibe Artist" },
                album: { title: "Vibe Album" },
            },
            onMapPresent: true,
            moodColor: null,
            onFlyTo: () => undefined,
        }),
    );

    assert.match(html, /data-preference-mode="both"/);
    assert.match(html, /data-button-size="h-11 w-11"/);
});

test("a confirmed Wave dislike advances with feedback semantics", async () => {
    const { NowPlayingConnected } =
        await import("../../components/vibe/NowPlayingConnected");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
        root.render(
            React.createElement(NowPlayingConnected, {
                track: {
                    id: "yt:vibe-track",
                    title: "Vibe Track",
                    duration: 180,
                    artist: { name: "Vibe Artist" },
                    album: { title: "Vibe Album" },
                },
                onMapPresent: true,
                moodColor: null,
                onFlyTo: () => undefined,
            }),
        );
    });

    const callback = state.dislikeAppliedCallbacks.at(-1);
    assert.ok(callback);
    await act(async () => callback("yt:vibe-track"));
    assert.deepEqual(state.advanceOrigins, ["feedback"]);

    await act(async () => root.unmount());
});

test("a late dislike response cannot skip the newly selected Wave track", async () => {
    const { NowPlayingConnected } =
        await import("../../components/vibe/NowPlayingConnected");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderTrack = (id: string) =>
        React.createElement(NowPlayingConnected, {
            track: {
                id,
                title: id,
                duration: 180,
                artist: { name: "Vibe Artist" },
                album: { title: "Vibe Album" },
            },
            onMapPresent: true,
            moodColor: null,
            onFlyTo: () => undefined,
        });

    await act(async () => root.render(renderTrack("yt:first")));
    const staleCallback = state.dislikeAppliedCallbacks.at(-1);
    assert.ok(staleCallback);

    await act(async () => root.render(renderTrack("yt:second")));
    await act(async () => staleCallback("yt:first"));
    assert.deepEqual(state.advanceOrigins, []);

    await act(async () => root.unmount());
});
