import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { BRAND_SLUG } from "@/lib/brand";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
    ownerId: "listener-1" as string | null,
    waveMode: "for-you",
    waveMood: null as string | null,
    waveLanguage: "any",
    appliedModes: [] as string[],
    appliedMoods: [] as Array<string | null>,
};

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ user: state.ownerId ? { id: state.ownerId } : null }),
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            waveMode: state.waveMode,
            waveMood: state.waveMood,
            waveLanguage: state.waveLanguage,
            setWaveLanguage: (language: string) => {
                state.waveLanguage = language;
            },
            setWaveMode: (mode: string) => {
                state.waveMode = mode;
                state.appliedModes.push(mode);
            },
            setWaveMood: (mood: string | null) => {
                state.waveMood = mood;
                state.appliedMoods.push(mood);
            },
        }),
    },
});

beforeEach(() => {
    state.ownerId = "listener-1";
    state.waveMode = "for-you";
    state.waveMood = null;
    state.appliedModes.length = 0;
    state.appliedMoods.length = 0;
    window.localStorage.clear();
});

after(() => GlobalRegistrator.unregister());

test("wave selection is restored before Home and Vibe consume shared audio state", async () => {
    window.localStorage.setItem(
        `${BRAND_SLUG}_wave_selection_v1:listener-1`,
        JSON.stringify({ mode: "new", mood: "focus", language: "ru" }),
    );
    const { WaveSelectionSynchronizer } =
        await import("@/components/providers/WaveSelectionSynchronizer");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
        root.render(React.createElement(WaveSelectionSynchronizer));
        await Promise.resolve();
    });

    assert.deepEqual(state.appliedModes, ["new"]);
    assert.deepEqual(state.appliedMoods, ["calm"]);
    assert.equal(state.waveLanguage, "any");

    await act(async () => root.unmount());
    container.remove();
});
