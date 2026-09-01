import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { api } from "../../lib/api";
import {
    activateUserPlaybackStorage,
    revokeUserPlaybackStorage,
} from "../../lib/userPlaybackStorage";

GlobalRegistrator.register({ url: "https://soundspan.test/" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let getPlaybackState = async (): Promise<unknown> => null;
let savePlaybackState = async (): Promise<unknown> => null;
let getTrack = async (id: string): Promise<unknown> => ({
    id,
    title: "Fetched track",
    artist: { name: "Fetched artist" },
    album: { title: "Fetched album" },
    duration: 180,
});
const getPlaybackStateMock = mock.method(api, "getPlaybackState", () =>
    getPlaybackState(),
);
const getTrackMock = mock.method(api, "getTrack", (id: string) => getTrack(id));
const clearPlaybackStateMock = mock.method(
    api,
    "clearPlaybackState",
    async () => undefined,
);
const savePlaybackStateMock = mock.method(api, "savePlaybackState", () =>
    savePlaybackState(),
);

after(async () => {
    getPlaybackStateMock.mock.restore();
    getTrackMock.mock.restore();
    clearPlaybackStateMock.mock.restore();
    savePlaybackStateMock.mock.restore();
    await GlobalRegistrator.unregister();
});

test("revocation prevents an unmount flush from restoring the previous user's queue", async () => {
    getPlaybackState = async () => null;
    localStorage.clear();
    localStorage.setItem("soundspan_volume", "0.7");
    activateUserPlaybackStorage("user-a");

    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider, useAudioState } =
        await import("../../lib/audio-state-context");
    type AudioState = ReturnType<typeof useAudioState>;
    let audioState: AudioState | null = null;
    const Probe = () => {
        audioState = useAudioState();
        return null;
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(
                AudioStateProvider,
                null,
                React.createElement(Probe),
            ),
        );
    });
    const track = {
        id: "track-a",
        title: "Private track A",
        artist: { name: "Artist A" },
        album: { title: "Album A" },
        duration: 180,
        itemType: "track" as const,
    };
    await React.act(async () => {
        assert.ok(audioState);
        audioState.setCurrentTrack(track);
        audioState.setPlaybackType("track");
        audioState.setQueue([track]);
    });

    revokeUserPlaybackStorage();
    await React.act(async () => root.unmount());
    container.remove();

    assert.equal(localStorage.getItem("soundspan_current_track"), null);
    assert.equal(localStorage.getItem("soundspan_queue"), null);
    assert.equal(localStorage.getItem("soundspan_playback_type"), null);
    assert.equal(localStorage.getItem("soundspan_volume"), "0.7");
});

test("a deferred startup snapshot from user A cannot mutate user B playback storage", async () => {
    localStorage.clear();
    activateUserPlaybackStorage("user-a");
    let resolvePlaybackState!: (value: unknown) => void;
    getPlaybackState = () =>
        new Promise((resolve) => {
            resolvePlaybackState = resolve;
        });
    const getTrackCallsBefore = getTrackMock.mock.callCount();
    const clearCallsBefore = clearPlaybackStateMock.mock.callCount();

    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider } =
        await import("../../lib/audio-state-context");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                AudioStateProvider,
                null,
                React.createElement("span"),
            ),
        );
        await Promise.resolve();
    });

    revokeUserPlaybackStorage();
    activateUserPlaybackStorage("user-b");
    await React.act(async () => {
        resolvePlaybackState({
            playbackType: "track",
            trackId: "track-a",
            queue: [],
            currentIndex: 0,
            isShuffle: false,
            currentTime: 73,
            updatedAt: new Date().toISOString(),
        });
        await Promise.resolve();
        await Promise.resolve();
    });

    assert.equal(getTrackMock.mock.callCount(), getTrackCallsBefore);
    assert.equal(clearPlaybackStateMock.mock.callCount(), clearCallsBefore);
    assert.equal(localStorage.getItem("soundspan_current_time"), null);
    assert.equal(localStorage.getItem("soundspan_current_time_track_id"), null);
    assert.equal(localStorage.getItem("soundspan_playback_owner_id"), "user-b");

    await React.act(async () => root.unmount());
    container.remove();
});

test("a deferred user A poll failure cannot clear user B playback state", async (testContext) => {
    localStorage.clear();
    activateUserPlaybackStorage("user-a");
    let playbackStateCallCount = 0;
    getPlaybackState = async () => {
        playbackStateCallCount += 1;
        if (playbackStateCallCount === 1) return null;
        return {
            playbackType: "track",
            trackId: "track-a",
            queue: [],
            currentIndex: 0,
            isShuffle: false,
            currentTime: 73,
            updatedAt: new Date(Date.now() + 60_000).toISOString(),
        };
    };
    let rejectTrack!: (reason: Error) => void;
    getTrack = () =>
        new Promise((_, reject) => {
            rejectTrack = reject;
        });
    const clearCallsBefore = clearPlaybackStateMock.mock.callCount();
    let pollCallback: (() => Promise<void>) | null = null;
    const originalSetTimeout = globalThis.setTimeout;
    testContext.mock.method(Math, "random", () => 0);
    testContext.mock.method(
        globalThis,
        "setInterval",
        (callback: TimerHandler) => {
            pollCallback = callback as () => Promise<void>;
            return 1 as unknown as ReturnType<typeof setInterval>;
        },
    );

    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider } =
        await import("../../lib/audio-state-context");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                AudioStateProvider,
                null,
                React.createElement("span"),
            ),
        );
        await Promise.resolve();
    });
    for (let attempt = 0; attempt < 5 && !pollCallback; attempt += 1) {
        await new Promise<void>((resolve) => originalSetTimeout(resolve, 0));
    }
    const scheduledPoll = pollCallback as (() => Promise<void>) | null;
    assert.ok(scheduledPoll, "expected playback polling to be scheduled");

    const pollPromise = scheduledPoll();
    for (let attempt = 0; attempt < 5 && !rejectTrack; attempt += 1) {
        await Promise.resolve();
    }
    assert.ok(rejectTrack, "expected the poll to request user A's track");

    revokeUserPlaybackStorage();
    activateUserPlaybackStorage("user-b");
    await React.act(async () => {
        rejectTrack(new Error("deferred user A track lookup failed"));
        await pollPromise;
    });

    assert.equal(clearPlaybackStateMock.mock.callCount(), clearCallsBefore);
    assert.equal(localStorage.getItem("soundspan_playback_owner_id"), "user-b");

    await React.act(async () => root.unmount());
    container.remove();
    getTrack = async (id: string) => ({
        id,
        title: "Fetched track",
        artist: { name: "Fetched artist" },
        album: { title: "Fetched album" },
        duration: 180,
    });
});

test("a deferred user A progress save cannot stamp user B local playback state", async () => {
    localStorage.clear();
    activateUserPlaybackStorage("user-a");
    getPlaybackState = async () => null;
    let resolveSave!: (value: unknown) => void;
    savePlaybackState = () =>
        new Promise((resolve) => {
            resolveSave = resolve;
        });

    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider, useAudioState } =
        await import("../../lib/audio-state-context");
    const { AudioPlaybackProvider } =
        await import("../../lib/audio-playback-context");
    type AudioState = ReturnType<typeof useAudioState>;
    let audioState: AudioState | null = null;
    const Probe = () => {
        audioState = useAudioState();
        return null;
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                AudioStateProvider,
                null,
                React.createElement(
                    AudioPlaybackProvider,
                    null,
                    React.createElement(Probe),
                ),
            ),
        );
    });
    const track = {
        id: "track-a",
        title: "Private track A",
        artist: { name: "Artist A" },
        album: { title: "Album A" },
        duration: 180,
        itemType: "track" as const,
    };
    await React.act(async () => {
        assert.ok(audioState);
        audioState.setQueue([track]);
        audioState.setCurrentIndex(0);
        audioState.setCurrentTrack(track);
        audioState.setPlaybackType("track");
        await Promise.resolve();
    });
    assert.ok(resolveSave, "expected a pending playback-state save");

    revokeUserPlaybackStorage();
    activateUserPlaybackStorage("user-b");
    await React.act(async () => {
        resolveSave(null);
        await Promise.resolve();
        await Promise.resolve();
    });

    assert.equal(
        localStorage.getItem("soundspan_last_playback_state_save_at"),
        null,
    );
    assert.equal(localStorage.getItem("soundspan_playback_owner_id"), "user-b");

    await React.act(async () => root.unmount());
    container.remove();
    savePlaybackState = async () => null;
});
