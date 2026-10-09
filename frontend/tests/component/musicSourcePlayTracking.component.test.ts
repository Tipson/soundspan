import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";
import { toAddToPlaylistRef } from "../../lib/trackRef";

before(() => {
    GlobalRegistrator.register();
    (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
});
after(() => GlobalRegistrator.unregister());

for (const provider of ["youtube", "vk", "yandex"] as const) {
    test(`${provider} actual tracker creates one play and finalizes contiguous progress`, async () => {
        const { api } = await import("../../lib/api");
        const { usePlayEngagementTracking } =
            await import("../../components/player/hooks/usePlayEngagementTracking");
        const { createRoot } = await import("react-dom/client");
        const track =
            provider === "youtube"
                ? {
                      id: "yt:synthetic01",
                      youtubeVideoId: "synthetic01",
                      title: "Song",
                      artist: { name: "Artist" },
                      album: { title: "Album" },
                      duration: 180,
                      streamSource: "youtube" as const,
                  }
                : toMusicSourcePlaybackTrack({
                      provider,
                      id: provider === "vk" ? "-12_34" : "123",
                      title: "Song",
                      artists: ["First", "Second"],
                      duration: 180.5,
                      contentVersion: "explicit",
                      preview: false,
                      isrc: "USABC1234567",
                  });
        if (provider !== "youtube")
            assert.throws(() => toAddToPlaylistRef(track));
        const log = mock.method(api, "logPlay", async () => ({
            id: "owned-play",
        }));
        const update = mock.method(api, "updatePlayEngagement", async () => ({
            success: true as const,
        }));
        let tracker: ReturnType<typeof usePlayEngagementTracking> | undefined;
        function Probe() {
            tracker = usePlayEngagementTracking({
                currentTrack: track,
                currentIndex: 0,
                playbackType: "track",
                isPlaying: true,
                isBuffering: false,
                vibeMode: false,
                waveMode: "for-you",
            });
            return null;
        }
        const container = document.createElement("div");
        const root = createRoot(container);
        try {
            await React.act(async () =>
                root.render(React.createElement(Probe)),
            );
            await React.act(
                async () => new Promise<void>((done) => setImmediate(done)),
            );
            assert.equal(log.mock.callCount(), 1);
            if (provider !== "youtube") {
                assert.deepEqual(log.mock.calls[0].arguments[0], {
                    musicSourceRecording: track.musicSourceRecording,
                });
            }
            await React.act(async () => {
                for (let position = 0; position <= 35; position += 5)
                    tracker!.noteProgress(position);
                tracker!.finishCompleted();
                tracker!.finishCompleted();
                await new Promise<void>((done) => setImmediate(done));
            });
            assert.equal(update.mock.callCount(), 1);
            assert.equal(update.mock.calls[0].arguments[0], "owned-play");
            assert.deepEqual(update.mock.calls[0].arguments[1], {
                listenedSeconds: 35,
                completionRatio: 1,
                outcome: "completed",
            });
        } finally {
            await React.act(async () => root.unmount());
            container.remove();
            log.mock.restore();
            update.mock.restore();
            localStorage.clear();
        }
    });
}
