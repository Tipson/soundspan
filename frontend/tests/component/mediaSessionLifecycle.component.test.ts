import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const playback = {
    isPlaying: false,
    currentTime: 0,
};

const track = {
    id: "track-1",
    title: "Offline song",
    duration: 180,
    artist: { name: "Artist" },
    album: { title: "Album", coverArt: null },
};

const media: {
    currentTrack: typeof track | null;
    currentAudiobook: null;
    currentPodcast: null;
    playbackType: "track" | null;
} = {
    currentTrack: track,
    currentAudiobook: null,
    currentPodcast: null,
    playbackType: "track",
};

const controls = {
    pause: mock.fn(() => undefined),
    resume: mock.fn(() => undefined),
    next: mock.fn(() => undefined),
    previous: mock.fn(() => undefined),
    seek: mock.fn((_time: number) => undefined),
    skipForward: mock.fn((_time: number) => undefined),
    skipBackward: mock.fn((_time: number) => undefined),
};

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => media,
        usePlaybackStatus: () => ({ isPlaying: playback.isPlaying }),
        useAudioControls: () => controls,
    },
});

mock.module("@/lib/audio-playback-context", {
    namedExports: {
        usePlaybackProgress: () => ({ currentTime: playback.currentTime }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (value: string) => value,
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            warn: () => undefined,
        },
    },
});

type MediaSessionAction =
    | "play"
    | "pause"
    | "previoustrack"
    | "nexttrack"
    | "seekbackward"
    | "seekforward"
    | "seekto";

const registered = new Map<MediaSessionAction, (() => void) | null>();
const registrationCounts = new Map<MediaSessionAction, number>();
const positionStates: Array<MediaPositionState | undefined> = [];

const mediaSession = {
    metadata: null as unknown,
    playbackState: "none" as MediaSessionPlaybackState,
    setActionHandler(action: MediaSessionAction, handler: (() => void) | null) {
        registered.set(action, handler);
        if (handler) {
            registrationCounts.set(
                action,
                (registrationCounts.get(action) ?? 0) + 1,
            );
        }
    },
    setPositionState(state?: MediaPositionState) {
        positionStates.push(state);
    },
};

class FakeMediaMetadata {
    constructor(readonly init: MediaMetadataInit) {}
}

beforeEach(() => {
    playback.isPlaying = false;
    playback.currentTime = 0;
    media.currentTrack = track;
    media.playbackType = "track";
    registered.clear();
    registrationCounts.clear();
    positionStates.length = 0;
    mediaSession.metadata = null;
    mediaSession.playbackState = "none";
    Object.defineProperty(navigator, "mediaSession", {
        configurable: true,
        value: mediaSession,
    });
    Object.defineProperty(globalThis, "MediaMetadata", {
        configurable: true,
        value: FakeMediaMetadata,
    });
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort test teardown.
    }
});

test("media controls attach on the first local play and stay stable across progress ticks", async (t) => {
    const { useMediaSession } = await import("../../hooks/useMediaSession");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => {
        await React.act(async () => root.unmount());
        container.remove();
    });

    function Probe() {
        useMediaSession();
        return null;
    }

    await React.act(async () => {
        root.render(React.createElement(Probe));
    });
    assert.equal(registered.get("play") ?? null, null);

    playback.isPlaying = true;
    await React.act(async () => {
        root.render(React.createElement(Probe));
    });

    assert.equal(typeof registered.get("play"), "function");
    assert.equal(registrationCounts.get("play"), 1);

    playback.currentTime = 1;
    await React.act(async () => {
        root.render(React.createElement(Probe));
    });
    playback.currentTime = 2;
    await React.act(async () => {
        root.render(React.createElement(Probe));
    });

    assert.equal(
        registrationCounts.get("play"),
        1,
        "position updates must not tear down and reinstall OS media handlers",
    );
});

test("media controls and lock-screen state clear after playback is paused and media is removed", async (t) => {
    const { useMediaSession } = await import("../../hooks/useMediaSession");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => {
        await React.act(async () => root.unmount());
        container.remove();
    });

    function Probe() {
        useMediaSession();
        return null;
    }

    playback.isPlaying = true;
    await React.act(async () => {
        root.render(React.createElement(Probe));
    });

    assert.equal(typeof registered.get("play"), "function");
    assert.equal(mediaSession.playbackState, "playing");
    assert.ok(mediaSession.metadata instanceof FakeMediaMetadata);

    playback.isPlaying = false;
    await React.act(async () => {
        root.render(React.createElement(Probe));
    });

    assert.equal(mediaSession.playbackState, "paused");

    media.currentTrack = null;
    media.playbackType = null;
    await React.act(async () => {
        root.render(React.createElement(Probe));
    });

    for (const action of [
        "play",
        "pause",
        "previoustrack",
        "nexttrack",
        "seekbackward",
        "seekforward",
        "seekto",
    ] as const) {
        assert.equal(registered.get(action) ?? null, null);
    }
    assert.equal(mediaSession.metadata, null);
    assert.equal(mediaSession.playbackState, "none");
    assert.equal(
        positionStates.at(-1),
        undefined,
        "the OS scrubber position must be cleared with the media item",
    );
});
