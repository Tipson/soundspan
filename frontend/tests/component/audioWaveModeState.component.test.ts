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
