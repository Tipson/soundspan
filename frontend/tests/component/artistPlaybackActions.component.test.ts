import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { writePlaybackReplacementIntent } from "../../lib/audio-engine/playbackAdvanceOrigin";
import { isCollectionPlayback } from "../../lib/collectionPlayback";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());
const played: unknown[][] = [];
const tracks = [
    {
        id: "one",
        title: "One",
        duration: 180,
        artist: { name: "Artist" },
        album: { title: "Album" },
    },
    {
        id: "two",
        title: "Two",
        duration: 180,
        artist: { name: "Artist" },
        album: { title: "Album" },
    },
];
mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: (...args: unknown[]) => {
                played.push(args);
                writePlaybackReplacementIntent("one");
            },
        }),
    },
});
mock.module("@/lib/artistPlayback", {
    namedExports: { loadOwnedArtistTracksNewestFirst: async () => tracks },
});
mock.module("@/hooks/trackPreferenceOptimistic", {
    namedExports: { buildOptimisticTrackPreferenceResponse: () => ({}) },
});
mock.module("@/features/device-offline/likedAutomation", {
    namedExports: { publishDeviceOfflineLikedChange: () => undefined },
});
mock.module("@/lib/api", { namedExports: { api: {} } });
mock.module("sonner", { namedExports: { toast: {} } });

test("local artist play and shuffle explicitly replace a foreign queue and mark successful ownership", async () => {
    const { useArtistActions } =
        await import("../../features/artist/hooks/useArtistActions");
    const { createRoot } = await import("react-dom/client");
    let actions!: ReturnType<typeof useArtistActions>;
    function Harness() {
        actions = useArtistActions();
        return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    const queryClient = new QueryClient();
    await React.act(async () =>
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(Harness),
            ),
        ),
    );
    for (const action of ["playAll", "shufflePlay"] as const) {
        writePlaybackReplacementIntent("foreign");
        await React.act(async () =>
            actions[action]({ id: "artist", name: "Artist" }, []),
        );
        const args = played.at(-1)!;
        assert.equal(args[1], 0);
        assert.equal(args[2], false);
        assert.deepEqual(args[3], { replaceQueue: true, preserveOrder: true });
        assert.equal((args[0] as unknown[]).length, 2);
        assert.equal(isCollectionPlayback("artist:artist"), true);
    }
    await React.act(async () => root.unmount());
    queryClient.clear();
});
