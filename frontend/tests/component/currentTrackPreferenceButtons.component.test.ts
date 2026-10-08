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
    advanceQueue: (reason: string) => {
        state.advances.push(reason);
    },
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
            advanceQueue: state.advanceQueue,
        }),
    },
});

beforeEach(() => {
    state.callbacks.length = 0;
    state.advances.length = 0;
    state.advanceQueue = (reason: string) => {
        state.advances.push(reason);
    };
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

for (const trackId of ["vk:-1_2", "yandex:0007", "yt:abcdefghijk"]) {
    test(`late ${trackId} feedback cannot race a replacement before React commits`, async () => {
        const { CurrentTrackPreferenceButtons } =
            await import("../../components/player/CurrentTrackPreferenceButtons");
        const { writePlaybackReplacementIntent } =
            await import("../../lib/audio-engine/playbackAdvanceOrigin");
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () =>
                root.render(
                    React.createElement(CurrentTrackPreferenceButtons, {
                        trackId,
                    }),
                ),
            );
            const oldConfirmation = state.callbacks.at(-1);
            assert.ok(oldConfirmation);
            await act(async () => {
                writePlaybackReplacementIntent(trackId);
                oldConfirmation(trackId);
            });
            assert.deepEqual(state.advances, []);
            await act(async () =>
                root.render(
                    React.createElement(CurrentTrackPreferenceButtons, {
                        trackId,
                    }),
                ),
            );
            const currentConfirmation = state.callbacks.at(-1);
            assert.ok(currentConfirmation);
            await act(async () => currentConfirmation(trackId));
            assert.deepEqual(state.advances, ["feedback"]);
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });
    test(`late ${trackId} feedback cannot use a replaced same-song queue`, async () => {
        const { CurrentTrackPreferenceButtons } =
            await import("../../components/player/CurrentTrackPreferenceButtons");
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () =>
                root.render(
                    React.createElement(CurrentTrackPreferenceButtons, {
                        trackId,
                    }),
                ),
            );
            const oldConfirmation = state.callbacks.at(-1);
            assert.ok(oldConfirmation);
            state.advanceQueue = (reason: string) => {
                state.advances.push(`new:${reason}`);
            };
            await act(async () =>
                root.render(
                    React.createElement(CurrentTrackPreferenceButtons, {
                        trackId,
                    }),
                ),
            );
            const currentConfirmation = state.callbacks.at(-1);
            assert.ok(currentConfirmation);
            await act(async () => oldConfirmation(trackId));
            assert.deepEqual(state.advances, []);
            await act(async () => currentConfirmation(trackId));
            assert.deepEqual(state.advances, ["new:feedback"]);
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });
    test(`late ${trackId} feedback cannot advance after controls leave the player`, async () => {
        const { CurrentTrackPreferenceButtons } =
            await import("../../components/player/CurrentTrackPreferenceButtons");
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () =>
                root.render(
                    React.createElement(CurrentTrackPreferenceButtons, {
                        trackId,
                    }),
                ),
            );
            const oldConfirmation = state.callbacks.at(-1);
            assert.ok(oldConfirmation);
            await act(async () =>
                root.render(React.createElement("div", null, "Подкаст")),
            );
            await act(async () => oldConfirmation(trackId));
            assert.deepEqual(state.advances, []);

            await act(async () =>
                root.render(
                    React.createElement(
                        React.StrictMode,
                        null,
                        React.createElement(CurrentTrackPreferenceButtons, {
                            trackId,
                        }),
                    ),
                ),
            );
            const currentConfirmation = state.callbacks.at(-1);
            assert.ok(currentConfirmation);
            await act(async () => oldConfirmation(trackId));
            assert.deepEqual(state.advances, []);
            await act(async () => currentConfirmation(trackId));
            assert.deepEqual(state.advances, ["feedback"]);
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });
}
