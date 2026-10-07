import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

type AudioState = ReturnType<
    (typeof import("../../lib/audio-state-context"))["useAudioState"]
>;

before(() => {
    GlobalRegistrator.register();
    (
        globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
});

after(() => {
    GlobalRegistrator.unregister();
});

test("attributed finite mixes remain finite after server and local queue restoration", async () => {
    const { api } = await import("../../lib/api");
    const { toProviderPlaybackTrack } =
        await import("../../lib/audio/providerRadioContinuation");
    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider, useAudioState } =
        await import("../../lib/audio-state-context");
    const lineage = {
        generationId: "daily-generation",
        sessionId: "client-session",
        queueMode: "finite" as const,
    };
    const queue = Array.from({ length: 40 }, (_, i) =>
        toProviderPlaybackTrack(
            {
                id: `yt:daily-${i}`,
                title: `Song ${i}`,
                duration: 180,
                trackNo: null,
                artist: { id: null, name: "Artist" },
                album: { id: null, title: "Album", coverArt: null },
                source: "youtube",
                streamSource: "youtube",
                youtubeVideoId: `daily-${i}`,
                provider: { tidalTrackId: null, youtubeVideoId: `daily-${i}` },
            },
            lineage,
        ),
    );
    for (const fromServer of [true, false]) {
        localStorage.clear();
        if (fromServer) localStorage.setItem("soundspan_vibe_mode", "false");
        else localStorage.setItem("soundspan_queue", JSON.stringify(queue));
        const serverState = fromServer
            ? {
                  playbackType: "track",
                  trackId: queue[0].id,
                  queue,
                  currentIndex: 0,
                  currentTime: 0,
                  isShuffle: false,
                  updatedAt: new Date().toISOString(),
              }
            : null;
        const getState = mock.method(
            api,
            "getPlaybackState",
            async () => serverState,
        );
        const stateRef = { current: null as AudioState | null };
        const Probe = () => {
            stateRef.current = useAudioState();
            return null;
        };
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
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
            assert.equal(stateRef.current?.queue.length, 40);
            assert.equal(
                stateRef.current?.vibeMode,
                false,
                fromServer
                    ? "server mix remains finite"
                    : "local mix remains finite",
            );
            assert.deepEqual(stateRef.current?.vibeQueueIds, []);
            const last = stateRef.current?.queue[39];
            assert.ok(last && last.itemType !== "episode");
            assert.equal(last.recommendationGenerationId, "daily-generation");
        } finally {
            await React.act(async () => root.unmount());
            container.remove();
            getState.mock.restore();
            localStorage.clear();
        }
    }
});

test("audio state exposes a typed Wave mode with a for-you default", async () => {
    localStorage.clear();
    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider, useAudioState } =
        await import("../../lib/audio-state-context");
    const stateRef = { current: null as AudioState | null };
    const Probe = () => {
        stateRef.current = useAudioState();
        return null;
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
        await React.act(async () => {
            root.render(
                React.createElement(
                    AudioStateProvider,
                    null,
                    React.createElement(Probe),
                ),
            );
        });
        assert.equal(stateRef.current?.waveMode, "for-you");
        assert.equal(stateRef.current?.waveLanguage, "any");
        await React.act(async () => {
            stateRef.current?.setWaveLanguage("ru");
        });
        assert.equal(stateRef.current?.waveLanguage, "ru");

        await React.act(async () => {
            stateRef.current?.setWaveMode("new");
        });
        assert.equal(stateRef.current?.waveMode, "new");

        await React.act(async () => {
            stateRef.current?.setWaveMode("familiar");
        });
        assert.equal(stateRef.current?.waveMode, "familiar");
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});

test("audio state restores a persisted Wave queue after a page restart", async () => {
    localStorage.clear();
    localStorage.setItem(
        "soundspan_queue",
        JSON.stringify([
            {
                id: "yt:seed",
                title: "Seed",
                artist: { name: "Artist" },
                album: { title: "Album" },
                duration: 180,
            },
            {
                id: "yt:continued",
                title: "Continued",
                artist: { name: "Artist" },
                album: { title: "Album" },
                duration: 200,
                recommendationGenerationId: "generation-1",
                recommendationSessionId: "session-1",
            },
        ]),
    );
    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider, useAudioState } =
        await import("../../lib/audio-state-context");
    const stateRef = { current: null as AudioState | null };
    const Probe = () => {
        stateRef.current = useAudioState();
        return null;
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
        await React.act(async () => {
            root.render(
                React.createElement(
                    AudioStateProvider,
                    null,
                    React.createElement(Probe),
                ),
            );
        });
        assert.equal(stateRef.current?.vibeMode, true);
        assert.deepEqual(stateRef.current?.vibeQueueIds, [
            "yt:seed",
            "yt:continued",
        ]);
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
        localStorage.clear();
    }
});

test("an explicitly stopped Wave stays stopped after a page restart", async () => {
    localStorage.clear();
    localStorage.setItem("soundspan_vibe_mode", "false");
    localStorage.setItem(
        "soundspan_queue",
        JSON.stringify([
            {
                id: "yt:continued",
                title: "Continued",
                artist: { name: "Artist" },
                album: { title: "Album" },
                duration: 200,
                recommendationGenerationId: "generation-1",
                recommendationSessionId: "session-1",
            },
        ]),
    );
    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider, useAudioState } =
        await import("../../lib/audio-state-context");
    const stateRef = { current: null as AudioState | null };
    const Probe = () => {
        stateRef.current = useAudioState();
        return null;
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
        await React.act(async () => {
            root.render(
                React.createElement(
                    AudioStateProvider,
                    null,
                    React.createElement(Probe),
                ),
            );
        });
        assert.equal(stateRef.current?.vibeMode, false);
        assert.deepEqual(stateRef.current?.vibeQueueIds, []);
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
        localStorage.clear();
    }
});
