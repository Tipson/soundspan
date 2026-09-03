import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://music.test/vibe" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let retryCalls = 0;
let feedResult: {
    data?: {
        shelves: {
            quickPicks: Array<{ id: string }>;
            discovery: Array<{ id: string }>;
            listenAgain: Array<{ id: string }>;
        };
    };
    isLoading: boolean;
    isError: boolean;
};
let feedResolver:
    | ((mode: string, mood: string | null) => typeof feedResult)
    | null = null;
const feedCalls: Array<[string, string | null]> = [];
const calls = {
    playTracks: [] as unknown[][],
    setUpcoming: [] as unknown[][],
    isShuffle: [] as unknown[],
    shuffleIndices: [] as unknown[][],
    vibeMode: [] as unknown[],
    vibeQueueIds: [] as unknown[][],
    vibeSourceFeatures: [] as unknown[],
    waveMode: [] as unknown[],
    waveMood: [] as unknown[],
};
const audioState = {
    currentTrack: null as { id: string } | null,
    vibeMode: false,
    waveMode: "for-you",
    waveMood: null as string | null,
};
const Icon = () => React.createElement("svg");

mock.module("lucide-react", {
    namedExports: {
        AudioWaveform: Icon,
        Heart: Icon,
        History: Icon,
        ListMusic: Icon,
        Loader2: Icon,
        Map: Icon,
        Pause: Icon,
        Play: Icon,
        RotateCcw: Icon,
        SkipForward: Icon,
        ThumbsDown: Icon,
    },
});
mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({
            isAuthenticated: true,
            isLoading: false,
            user: { id: "user-1", username: "listener" },
        }),
    },
});
mock.module("next/link", {
    defaultExport: ({ href, children, ...props }: React.ComponentProps<"a">) =>
        React.createElement("a", { href, ...props }, children),
});
mock.module("@/features/home/components/PersonalizedTrackShelf", {
    namedExports: { PersonalizedTrackShelf: () => null },
});
mock.module("@/features/home/hooks/usePersonalizedHomeFeed", {
    namedExports: {
        usePersonalizedHomeFeed: (
            _limit: number,
            _enabled: boolean,
            mode: string,
            mood: string | null,
        ) => {
            feedCalls.push([mode, mood]);
            const result = feedResolver ? feedResolver(mode, mood) : feedResult;
            return {
                ...result,
                refetch: async () => {
                    retryCalls += 1;
                },
            };
        },
    },
});
mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: (...args: unknown[]) => calls.playTracks.push(args),
            advanceQueue() {},
            pause() {},
            play() {},
            setUpcoming: (...args: unknown[]) => calls.setUpcoming.push(args),
        }),
    },
});
mock.module("@/lib/audio-playback-context", {
    namedExports: {
        usePlaybackStatus: () => ({ isPlaying: false }),
    },
});
mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            ...audioState,
            setIsShuffle: (value: unknown) => calls.isShuffle.push(value),
            setShuffleIndices: (value: unknown[]) =>
                calls.shuffleIndices.push(value),
            setVibeMode: (value: unknown) => calls.vibeMode.push(value),
            setVibeQueueIds: (value: unknown[]) =>
                calls.vibeQueueIds.push(value),
            setVibeSourceFeatures: (value: unknown) =>
                calls.vibeSourceFeatures.push(value),
            setWaveMode: (value: unknown) => calls.waveMode.push(value),
            setWaveMood: (value: unknown) => calls.waveMood.push(value),
        }),
    },
});
mock.module("@/lib/audio/providerRadioContinuation", {
    namedExports: { toProviderPlaybackTrack: (track: unknown) => track },
});
mock.module("@/components/vibe/NowPlayingConnected", {
    namedExports: { NowPlayingConnected: () => null },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    retryCalls = 0;
    feedResult = {
        data: undefined,
        isLoading: false,
        isError: true,
    };
    feedResolver = null;
    feedCalls.length = 0;
    Object.values(calls).forEach((entries) => {
        entries.length = 0;
    });
    audioState.currentTrack = null;
    audioState.vibeMode = false;
    audioState.waveMode = "for-you";
    audioState.waveMood = null;
    window.history.replaceState({}, "", "https://music.test/vibe");
});

test("Vibe recommendation failure exposes a touch-sized retry action", async () => {
    const { VibeProviderFallback } =
        await import("../../components/vibe/VibeAvailability");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(VibeProviderFallback));
    });
    const retry = container.querySelector(
        'button[aria-label="Повторить загрузку рекомендаций моей волны"]',
    ) as HTMLButtonElement | null;
    assert.ok(retry);
    assert.match(retry.className, /min-h-11/);
    await React.act(async () => {
        retry.click();
        await Promise.resolve();
    });
    assert.equal(retryCalls, 1);

    await React.act(async () => root.unmount());
    container.remove();
});

test("Vibe starts its ranked queue with shuffle explicitly disabled", async () => {
    feedResult = {
        data: {
            shelves: {
                quickPicks: [{ id: "quick" }],
                discovery: [{ id: "fresh" }],
                listenAgain: [{ id: "again" }],
            },
        },
        isLoading: false,
        isError: false,
    };
    const { VibeProviderFallback } =
        await import("../../components/vibe/VibeAvailability");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(VibeProviderFallback));
        await Promise.resolve();
    });
    const playButton = container.querySelector(
        'button[aria-label="Включить мою волну"]',
    ) as HTMLButtonElement | null;
    assert.ok(playButton);

    await React.act(async () => playButton.click());

    assert.deepEqual(calls.isShuffle, [false]);
    assert.deepEqual(calls.shuffleIndices, [[]]);
    assert.deepEqual(calls.playTracks[0]?.slice(1), [0, true]);

    await React.act(async () => root.unmount());
    container.remove();
});

test("Wave hides unrelated current and seed tracks until its own session starts", async () => {
    audioState.currentTrack = { id: "playing-elsewhere" };
    audioState.vibeMode = false;
    feedResult = {
        data: {
            shelves: {
                quickPicks: [{ id: "wave-seed" }],
                discovery: [],
                listenAgain: [],
            },
        },
        isLoading: false,
        isError: false,
    };
    const { VibeProviderFallback } =
        await import("../../components/vibe/VibeAvailability");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(VibeProviderFallback));
        await Promise.resolve();
    });

    assert.equal(
        container.querySelector('[data-testid="wave-now-playing-panel"]'),
        null,
    );
    assert.equal(
        container.querySelector('[data-testid="wave-next-preview"]'),
        null,
    );

    await React.act(async () => root.unmount());
    container.remove();
});

test("an active Wave retunes to a mood supplied by the Home shortcut", async () => {
    window.history.replaceState({}, "", "https://music.test/vibe?mood=calm");
    audioState.currentTrack = { id: "playing" };
    audioState.vibeMode = true;
    feedResolver = (_mode, mood) => ({
        data: {
            shelves: {
                quickPicks: mood === "calm" ? [{ id: "calm-pick" }] : [],
                discovery: [],
                listenAgain: [],
            },
        },
        isLoading: false,
        isError: false,
    });
    const { VibeProviderFallback } =
        await import("../../components/vibe/VibeAvailability");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(VibeProviderFallback));
        await Promise.resolve();
        await Promise.resolve();
    });
    await React.act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 340));
        await Promise.resolve();
    });

    assert.ok(feedCalls.some(([, mood]) => mood === "calm"));
    assert.deepEqual(calls.playTracks, [[[{ id: "calm-pick" }], 0, true]]);
    assert.deepEqual(calls.setUpcoming, []);
    assert.deepEqual(calls.vibeQueueIds, [["calm-pick"]]);

    await React.act(async () => root.unmount());
    container.remove();
});

for (const recommendationState of ["error", "empty"] as const) {
    test(`an active Wave keeps its current queue when retuning returns ${recommendationState}`, async () => {
        window.history.replaceState(
            {},
            "",
            "https://music.test/vibe?mood=focus",
        );
        audioState.currentTrack = { id: "playing" };
        audioState.vibeMode = true;
        feedResult = {
            data:
                recommendationState === "empty"
                    ? {
                          shelves: {
                              quickPicks: [],
                              discovery: [],
                              listenAgain: [],
                          },
                      }
                    : undefined,
            isLoading: false,
            isError: recommendationState === "error",
        };
        const { VibeProviderFallback } =
            await import("../../components/vibe/VibeAvailability");
        const { createRoot } = await import("react-dom/client");
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);

        await React.act(async () => {
            root.render(React.createElement(VibeProviderFallback));
            await Promise.resolve();
            await Promise.resolve();
        });
        await React.act(async () => {
            await new Promise((resolve) => window.setTimeout(resolve, 340));
            await Promise.resolve();
        });

        assert.deepEqual(calls.setUpcoming, []);
        assert.deepEqual(calls.vibeQueueIds, []);

        await React.act(async () => root.unmount());
        container.remove();
    });
}
