import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let retryCalls = 0;
const Icon = () => React.createElement("svg");

mock.module("lucide-react", {
    namedExports: {
        AudioWaveform: Icon,
        Heart: Icon,
        History: Icon,
        ListMusic: Icon,
        Loader2: Icon,
        Map: Icon,
        Play: Icon,
        RotateCcw: Icon,
        SkipForward: Icon,
        ThumbsDown: Icon,
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
        usePersonalizedHomeFeed: () => ({
            data: undefined,
            isLoading: false,
            isError: true,
            refetch: async () => {
                retryCalls += 1;
            },
        }),
    },
});
mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({ playTracks() {}, advanceQueue() {} }),
    },
});
mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: null,
            setVibeMode() {},
            setVibeQueueIds() {},
            setVibeSourceFeatures() {},
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

test("Vibe recommendation failure exposes a touch-sized retry action", async () => {
    retryCalls = 0;
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
        'button[aria-label="Retry My Wave recommendations"]',
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
