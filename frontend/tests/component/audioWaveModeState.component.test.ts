import assert from "node:assert/strict";
import { after, before, test } from "node:test";
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
