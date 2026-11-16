import assert from "node:assert/strict";
import { after, beforeEach, mock, test, type TestContext } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React, { useLayoutEffect } from "react";
import { api } from "../../lib/api";
import type { Track } from "../../lib/audio-state-context";
import { activateUserPlaybackStorage } from "../../lib/userPlaybackStorage";
import {
    setListenTogetherMembershipPending,
    setListenTogetherSessionSnapshot,
} from "../../lib/listen-together-session";

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
    setListenTogetherSessionSnapshot(null);
    setListenTogetherMembershipPending(false);
});

function song(id: string): Track {
    return {
        id,
        title: id,
        duration: 100,
        artist: { name: "Artist" },
        album: { title: "Album" },
    };
}

async function mount(context: TestContext) {
    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider, useAudioState } =
        await import("../../lib/audio-state-context");
    const { AudioPlaybackProvider, usePlaybackStatus, usePlaybackProgress } =
        await import("../../lib/audio-playback-context");
    const { AudioControlsProvider, useAudioControls } =
        await import("../../lib/audio-controls-context");
    activateUserPlaybackStorage("occurrence-owner");
    type Snapshot = {
        state: ReturnType<typeof useAudioState>;
        controls: ReturnType<typeof useAudioControls>;
        status: ReturnType<typeof usePlaybackStatus>;
        time: number;
    };
    const live: { value: Snapshot | null } = { value: null };
    function Probe() {
        const state = useAudioState();
        const controls = useAudioControls();
        const status = usePlaybackStatus();
        const { currentTime: time } = usePlaybackProgress();
        useLayoutEffect(() => {
            live.value = { state, controls, status, time };
        });
        return null;
    }
    const node = document.createElement("div");
    document.body.appendChild(node);
    const root = createRoot(node);
    context.after(async () => {
        setListenTogetherSessionSnapshot(null);
        setListenTogetherMembershipPending(false);
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
    return () => {
        assert.ok(live.value);
        return live.value;
    };
}

test("real controls keep one local occurrence through past-row removal and tail replacement, then commit a duplicate", async (context) => {
    const current = await mount(context);
    const duplicate = song("same-recording");
    await React.act(async () =>
        current().controls.playTracks(
            [song("past"), duplicate, duplicate],
            1,
            false,
            {
                replaceQueue: true,
                preserveOrder: true,
            },
        ),
    );
    assert.equal(current().state.localTrackPlaybackOccurrence, 1);
    await React.act(async () => current().status.setCurrentTime(5));
    await React.act(async () => current().controls.removeFromQueue(0));
    assert.equal(current().state.currentIndex, 0);
    assert.equal(current().state.currentTrack?.id, duplicate.id);
    assert.equal(current().state.localTrackPlaybackOccurrence, 1);
    assert.equal(current().time, 5);
    await React.act(async () =>
        current().controls.setUpcoming([duplicate, song("tail")], true),
    );
    assert.equal(current().state.localTrackPlaybackOccurrence, 1);
    await React.act(async () => current().controls.playQueueIndex(1));
    assert.equal(current().state.localTrackPlaybackOccurrence, 2);
    assert.equal(current().state.currentTrack?.id, duplicate.id);
    assert.equal(current().time, 0);
});

test("same object and index explicitly replay, while pause, seek and metadata preserve the local occurrence", async (context) => {
    const current = await mount(context);
    const track = song("same");
    for (const expected of [1, 2]) {
        await React.act(async () =>
            current().controls.playTracks([track], 0, false, {
                replaceQueue: true,
                preserveOrder: true,
            }),
        );
        assert.equal(current().state.localTrackPlaybackOccurrence, expected);
    }
    await React.act(async () => current().controls.pause());
    await React.act(async () => current().controls.seek(22));
    await React.act(async () =>
        current().state.setCurrentTrack({ ...track, title: "Enriched title" }),
    );
    assert.equal(current().state.localTrackPlaybackOccurrence, 2);
    await React.act(async () => current().controls.resume());
    assert.equal(current().state.localTrackPlaybackOccurrence, 2);
});

for (const operation of [
    "playTrack",
    "addTracks",
    "playNext",
    "playNow",
    "setUpcoming",
] as const) {
    test(`real controls ${operation} commits an empty-player track start once`, async (context) => {
        const current = await mount(context);
        await React.act(async () => {
            const { controls } = current();
            const track = song(operation);
            if (operation === "playTrack") controls.playTrack(track);
            if (operation === "addTracks")
                controls.addTracksToQueue([track], { silent: true });
            if (operation === "playNext") controls.playNext(track);
            if (operation === "playNow") controls.playNow(track);
            if (operation === "setUpcoming")
                controls.setUpcoming([track], true);
        });
        assert.equal(current().state.currentTrack?.id, operation);
        assert.equal(current().state.localTrackPlaybackOccurrence, 1);
    });
}

test("the local commit callback renders even when all media setters are unchanged and ignores pending or active group membership", async (context) => {
    const current = await mount(context);
    assert.equal(current().state.localTrackPlaybackOccurrence, 0);
    await React.act(async () =>
        current().state.commitLocalTrackPlaybackOccurrence(),
    );
    assert.equal(current().state.localTrackPlaybackOccurrence, 1);
    setListenTogetherMembershipPending(true);
    await React.act(async () =>
        current().state.commitLocalTrackPlaybackOccurrence(),
    );
    assert.equal(current().state.localTrackPlaybackOccurrence, 1);
    setListenTogetherMembershipPending(false);
    setListenTogetherSessionSnapshot({
        groupId: "group",
        isHost: true,
        playback: {
            isPlaying: true,
            positionMs: 0,
            serverTime: Date.now(),
            currentIndex: 0,
        },
    });
    await React.act(async () =>
        current().state.commitLocalTrackPlaybackOccurrence(),
    );
    assert.equal(current().state.localTrackPlaybackOccurrence, 1);
    setListenTogetherSessionSnapshot(null);
    await React.act(async () =>
        current().state.commitLocalTrackPlaybackOccurrence(),
    );
    assert.equal(current().state.localTrackPlaybackOccurrence, 2);
});
