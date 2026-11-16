import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import { api } from "../../lib/api";
import type { Track } from "../../lib/audio-state-context";
import { activateUserPlaybackStorage } from "../../lib/userPlaybackStorage";
import { captureRecommendationFeedback } from "../../lib/audio/recommendationFeedbackBridge";
import { consumePlaybackAdvanceOrigin } from "../../lib/audio-engine/playbackAdvanceOrigin";

GlobalRegistrator.register({ url: "https://soundspan.test/" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const read = mock.method(api, "getPlaybackState", async () => null);
const save = mock.method(api, "savePlaybackState", async () => null);
const clear = mock.method(api, "clearPlaybackState", async () => undefined);
after(() => {
    read.mock.restore();
    save.mock.restore();
    clear.mock.restore();
    GlobalRegistrator.unregister();
});
beforeEach(() => {
    localStorage.clear();
    consumePlaybackAdvanceOrigin();
});

function song(id: string): Track {
    return {
        id,
        title: id,
        duration: 180,
        artist: { name: "One artist" },
        album: { title: "Album" },
        recommendationSessionId: "manual-actions-wave",
    };
}

for (const scenario of [
    "manual enqueue",
    "manual replacement",
    "repeat all",
    "disliked repeat one",
    "immediate feedback",
] as const) {
    test(`real player contexts: ${scenario} respects exact feedback and manual intent`, async (context) => {
        const { createRoot } = await import("react-dom/client");
        const { AudioStateProvider, useAudioState } =
            await import("../../lib/audio-state-context");
        const {
            AudioPlaybackProvider,
            usePlaybackStatus,
            usePlaybackProgress,
        } = await import("../../lib/audio-playback-context");
        const { AudioControlsProvider, useAudioControls } =
            await import("../../lib/audio-controls-context");
        activateUserPlaybackStorage("manual-actions-owner");
        type Snapshot = {
            state: ReturnType<typeof useAudioState>;
            controls: ReturnType<typeof useAudioControls>;
            status: ReturnType<typeof usePlaybackStatus>;
            time: number;
        };
        const live: { value: Snapshot | null } = { value: null };
        function Probe() {
            live.value = {
                state: useAudioState(),
                controls: useAudioControls(),
                status: usePlaybackStatus(),
                time: usePlaybackProgress().currentTime,
            };
            return null;
        }
        const current = () => {
            assert.ok(live.value);
            return live.value;
        };
        const node = document.createElement("div");
        document.body.appendChild(node);
        const root = createRoot(node);
        context.after(async () => {
            await React.act(async () => root.unmount());
            node.remove();
        });
        await React.act(async () =>
            root.render(
                React.createElement(
                    AudioStateProvider,
                    null,
                    React.createElement(
                        AudioPlaybackProvider,
                        null,
                        React.createElement(
                            AudioControlsProvider,
                            null,
                            React.createElement(Probe),
                        ),
                    ),
                ),
            ),
        );
        const initial =
            scenario === "immediate feedback"
                ? [song("a"), song("a"), song("b"), song("c")]
                : [song("a"), song("b"), song("a"), song("c")];
        const start =
            scenario === "disliked repeat one" ||
            scenario === "immediate feedback"
                ? 0
                : scenario === "repeat all"
                  ? 3
                  : 1;
        await React.act(async () => {
            const { state, status } = current();
            state.setQueue(initial);
            state.setCurrentIndex(start);
            state.setCurrentTrack(initial[start]);
            state.setPlaybackType("track");
            state.setRepeatMode(
                scenario === "repeat all"
                    ? "all"
                    : scenario === "disliked repeat one"
                      ? "one"
                      : "off",
            );
            status.setDuration(180);
            status.setIsPlaying(false);
        });
        await React.act(async () => current().status.setCurrentTime(37));
        if (scenario === "immediate feedback") {
            await React.act(async () =>
                current().controls.advanceQueue("feedback"),
            );
            assert.deepEqual(
                current().state.queue.map((item) => item.id),
                ["a", "b", "c"],
            );
            assert.equal(current().state.currentTrack?.id, "b");
            assert.equal(current().state.currentIndex, 1);
            return;
        }
        await React.act(async () => {
            captureRecommendationFeedback("a", "thumbs_down");
        });
        assert.equal(
            current().time,
            37,
            "queue pruning must preserve the real playback provider clock",
        );
        if (scenario === "manual enqueue") {
            await React.act(async () =>
                current().controls.addToQueue(initial[2], { silent: true }),
            );
            assert.deepEqual(
                current().state.queue.map((item) => item.id),
                ["a", "b", "c", "a"],
            );
            assert.equal(current().state.currentTrack?.id, "b");
            assert.equal(current().time, 37);
            assert.equal(
                initial[2].recommendationSessionId,
                "manual-actions-wave",
            );
        } else if (scenario === "manual replacement") {
            await React.act(async () =>
                current().controls.playTracks(
                    [initial[3], initial[2]],
                    0,
                    false,
                    { replaceQueue: true, preserveOrder: true },
                ),
            );
            assert.deepEqual(
                current().state.queue.map((item) => item.id),
                ["c", "a"],
            );
            assert.equal(current().state.currentTrack?.id, "c");
        } else {
            await React.act(async () => current().controls.next());
            assert.equal(current().state.currentTrack?.id, "b");
        }
    });
}
