import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";

const playback = {
    isPlaying: false,
    currentTime: 0,
    duration: 240,
    isBuffering: false,
    targetSeekPosition: null,
    canSeek: true,
    downloadProgress: null,
    isSeekLocked: false,
    audioError: null,
    playbackState: "IDLE",
    streamProfile: null,
    setIsPlaying(value: boolean) {
        this.isPlaying = value;
    },
    setCurrentTime(value: number) {
        this.currentTime = value;
    },
    setTargetSeekPosition() {},
    lockSeek() {},
    unlockSeek() {},
};
mock.module("../../lib/audio-playback-context", {
    namedExports: {
        useAudioPlayback: () => playback,
        usePlaybackStatus: () => playback,
        usePlaybackProgress: () => playback,
    },
});
before(() => {
    GlobalRegistrator.register();
    (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
});
after(() => {
    mock.restoreAll();
    GlobalRegistrator.unregister();
});

for (const provider of ["vk", "yandex"] as const) {
    for (const membership of [
        "pending",
        "active",
        "joined-and-left",
    ] as const) {
        test(`${provider} held private snapshot cannot supersede ${membership} group membership`, async () => {
            localStorage.clear();
            const { api } = await import("../../lib/api");
            const { AudioStateProvider, useAudioState } =
                await import("../../lib/audio-state-context");
            const {
                setListenTogetherMembershipPending,
                setListenTogetherSessionSnapshot,
            } = await import("../../lib/listen-together-session");
            const { createRoot } = await import("react-dom/client");
            const remote = toMusicSourcePlaybackTrack({
                provider,
                id: provider === "vk" ? "-12_34" : "123",
                title: "Private track",
                artists: ["Artist"],
                duration: 180,
                contentVersion: "unknown",
                preview: false,
            });
            let release!: (value: unknown) => void;
            const get = mock.method(
                api,
                "getPlaybackState",
                () =>
                    new Promise((resolve) => {
                        release = resolve;
                    }),
            );
            const clear = mock.method(api, "clearPlaybackState", async () => ({
                success: true,
            }));
            const stateRef: {
                current: ReturnType<typeof useAudioState> | null;
            } = { current: null };
            function Probe() {
                stateRef.current = useAudioState();
                return null;
            }
            const container = document.createElement("div"),
                root = createRoot(container);
            try {
                await React.act(async () =>
                    root.render(
                        React.createElement(
                            AudioStateProvider,
                            null,
                            React.createElement(Probe),
                        ),
                    ),
                );
                if (membership === "active")
                    setListenTogetherSessionSnapshot({
                        groupId: "fixture-group",
                        isHost: false,
                        playback: {
                            isPlaying: false,
                            positionMs: 0,
                            serverTime: Date.now(),
                            currentIndex: 0,
                        },
                    });
                else {
                    setListenTogetherMembershipPending(true);
                    if (membership === "joined-and-left")
                        setListenTogetherMembershipPending(false);
                }
                await React.act(async () =>
                    release({
                        playbackType: "track",
                        trackId: remote.id,
                        queue: [remote],
                        currentIndex: 0,
                        currentTime: 73,
                        isPlaying: false,
                        updatedAt: new Date().toISOString(),
                    }),
                );
                assert.equal(stateRef.current?.currentTrack, null);
                assert.equal(stateRef.current?.queue.length, 0);
                assert.equal(
                    localStorage.getItem("soundspan_current_time"),
                    null,
                );
                assert.equal(clear.mock.callCount(), 0);
            } finally {
                await React.act(async () => root.unmount());
                container.remove();
                get.mock.restore();
                clear.mock.restore();
                setListenTogetherMembershipPending(false);
                setListenTogetherSessionSnapshot(null);
                localStorage.clear();
            }
        });
    }
    for (const command of [
        "state-setters",
        "playTracks",
        "playTracks-after-storage-flush",
    ] as const) {
        test(`${provider} held startup restore preserves ${command} selection and position`, async () => {
            localStorage.clear();
            playback.isPlaying = false;
            playback.currentTime = 0;
            const { api } = await import("../../lib/api");
            const { AudioStateProvider, useAudioState } =
                await import("../../lib/audio-state-context");
            const { AudioControlsProvider, useAudioControls } =
                await import("../../lib/audio-controls-context");
            const { createRoot } = await import("react-dom/client");
            const remote = toMusicSourcePlaybackTrack({
                provider,
                id: provider === "vk" ? "-12_34" : "123",
                title: "Old remote",
                artists: ["Remote Artist"],
                duration: 180,
                contentVersion: "unknown",
                preview: false,
            });
            const local = {
                id: "library-selected",
                title: "Selected",
                artist: { name: "Selected Artist" },
                album: { title: "Album" },
                duration: 240,
            };
            let release!: (value: unknown) => void;
            const gate = new Promise((resolve) => {
                release = resolve;
            });
            const get = mock.method(api, "getPlaybackState", () => gate);
            const lookup = mock.method(api, "getTrack", async () => {
                throw new Error("Unexpected library lookup");
            });
            const clear = mock.method(api, "clearPlaybackState", async () => ({
                success: true,
            }));
            const stateRef: {
                current: ReturnType<typeof useAudioState> | null;
            } = { current: null };
            const controlsRef: {
                current: ReturnType<typeof useAudioControls> | null;
            } = { current: null };
            function Probe() {
                stateRef.current = useAudioState();
                controlsRef.current = useAudioControls();
                return null;
            }
            const container = document.createElement("div"),
                root = createRoot(container);
            try {
                await React.act(async () =>
                    root.render(
                        React.createElement(
                            AudioStateProvider,
                            null,
                            React.createElement(
                                AudioControlsProvider,
                                null,
                                React.createElement(Probe),
                            ),
                        ),
                    ),
                );
                if (command === "state-setters") {
                    await React.act(async () => {
                        stateRef.current!.setCurrentTrack(local);
                        stateRef.current!.setQueue([local]);
                        stateRef.current!.setCurrentIndex(0);
                        stateRef.current!.setPlaybackType("track");
                    });
                    localStorage.setItem("soundspan_current_time", "0");
                    localStorage.setItem(
                        "soundspan_current_time_track_id",
                        local.id,
                    );
                } else
                    await React.act(async () =>
                        controlsRef.current!.playTracks([local], 0, false, {
                            replaceQueue: true,
                        }),
                    );
                assert.equal(stateRef.current?.currentTrack?.id, local.id);
                if (command === "playTracks-after-storage-flush")
                    await React.act(
                        async () =>
                            new Promise<void>((done) => setTimeout(done, 350)),
                    );
                else
                    assert.equal(
                        localStorage.getItem("soundspan_current_track"),
                        null,
                    );
                await React.act(async () =>
                    release({
                        playbackType: "track",
                        trackId: remote.id,
                        queue: [remote],
                        currentIndex: 0,
                        currentTime: 73,
                        isPlaying: false,
                        updatedAt: new Date().toISOString(),
                    }),
                );
                await React.act(
                    async () => new Promise<void>((done) => setImmediate(done)),
                );
                assert.equal(stateRef.current?.currentTrack?.id, local.id);
                assert.deepEqual(
                    stateRef.current?.queue.map((item) => item.id),
                    [local.id],
                );
                assert.equal(stateRef.current?.currentIndex, 0);
                assert.equal(
                    localStorage.getItem("soundspan_current_time"),
                    "0",
                );
                assert.equal(
                    localStorage.getItem("soundspan_current_time_track_id"),
                    local.id,
                );
                assert.equal(lookup.mock.callCount(), 0);
                assert.equal(clear.mock.callCount(), 0);
            } finally {
                await React.act(async () => root.unmount());
                container.remove();
                get.mock.restore();
                lookup.mock.restore();
                clear.mock.restore();
                localStorage.clear();
            }
        });
    }
}
