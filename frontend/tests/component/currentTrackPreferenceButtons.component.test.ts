import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type AppliedCallback = (trackId: string) => void;

const state = {
    callbacks: [] as AppliedCallback[],
    advances: [] as string[],
};

mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: {
        TrackPreferenceButtons: (props: {
            onThumbsDownApplied?: AppliedCallback;
        }) => {
            if (props.onThumbsDownApplied) {
                state.callbacks.push(props.onThumbsDownApplied);
            }
            return React.createElement("div", {
                "data-testid": "preference-buttons",
            });
        },
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            advanceQueue: (reason: string) => state.advances.push(reason),
        }),
    },
});

beforeEach(() => {
    state.callbacks.length = 0;
    state.advances.length = 0;
});

afterEach(() => {
    document.body.innerHTML = "";
});

test("confirmed dislike advances the still-active track as feedback", async () => {
    const { CurrentTrackPreferenceButtons } =
        await import("../../components/player/CurrentTrackPreferenceButtons");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
        root.render(
            React.createElement(CurrentTrackPreferenceButtons, {
                trackId: "track-1",
            }),
        );
    });
    const callback = state.callbacks.at(-1);
    assert.ok(callback);
    await act(async () => callback("track-1"));

    assert.deepEqual(state.advances, ["feedback"]);
    await act(async () => root.unmount());
});

test("late dislike confirmation cannot skip a newly selected track", async () => {
    const { CurrentTrackPreferenceButtons } =
        await import("../../components/player/CurrentTrackPreferenceButtons");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
        root.render(
            React.createElement(CurrentTrackPreferenceButtons, {
                trackId: "track-1",
            }),
        );
    });
    const firstCallback = state.callbacks.at(-1);
    assert.ok(firstCallback);

    await act(async () => {
        root.render(
            React.createElement(CurrentTrackPreferenceButtons, {
                trackId: "track-2",
            }),
        );
    });
    const secondCallback = state.callbacks.at(-1);
    assert.ok(secondCallback);

    await act(async () => firstCallback("track-1"));
    assert.deepEqual(state.advances, []);

    await act(async () => secondCallback("track-2"));
    assert.deepEqual(state.advances, ["feedback"]);
    await act(async () => root.unmount());
});
