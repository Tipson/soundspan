import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";

before(() => {
    GlobalRegistrator.register();
    (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
});
after(() => GlobalRegistrator.unregister());

for (const provider of ["vk", "yandex"] as const) {
    for (const malformed of [false, true]) {
        test(`${provider} server restore ${malformed ? "keeps an incomplete legacy snapshot without library clear" : "retains selected recording and paused position"}`, async () => {
            localStorage.clear();
            const { api } = await import("../../lib/api");
            const { AudioStateProvider, useAudioState } =
                await import("../../lib/audio-state-context");
            const { createRoot } = await import("react-dom/client");
            const current = toMusicSourcePlaybackTrack({
                provider,
                id: provider === "vk" ? "-12_34" : "123",
                title: "Song",
                artists: ["First", "Second"],
                duration: 180,
                contentVersion: "explicit",
                preview: false,
                isrc: "USABC1234567",
            });
            const selected = {
                ...current,
                recommendationSessionId: "selected-occurrence",
                ...(malformed ? { musicSourceRecording: undefined } : {}),
            };
            const queue = [
                { ...current, recommendationSessionId: "other-occurrence" },
                selected,
            ];
            if (malformed)
                queue[0] = { ...queue[0], musicSourceRecording: undefined };
            const getState = mock.method(api, "getPlaybackState", async () => ({
                playbackType: "track",
                trackId: current.id,
                queue,
                currentIndex: 1,
                currentTime: 73,
                isPlaying: false,
                updatedAt: new Date().toISOString(),
            }));
            const getTrack = mock.method(api, "getTrack", async () => {
                throw Object.assign(new Error("Library lookup must not run"), {
                    status: 404,
                });
            });
            const clear = mock.method(api, "clearPlaybackState", async () => ({
                success: true,
            }));
            const stateRef: {
                current: ReturnType<typeof useAudioState> | null;
            } = { current: null };
            function Probe() {
                stateRef.current = useAudioState();
                return null;
            }
            const container = document.createElement("div"),
                root = createRoot(container);
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
                await React.act(
                    async () =>
                        new Promise<void>((resolve) => setImmediate(resolve)),
                );
                assert.equal(getTrack.mock.callCount(), 0);
                assert.equal(clear.mock.callCount(), 0);
                if (malformed) {
                    assert.equal(stateRef.current?.currentTrack, null);
                    assert.equal(stateRef.current?.queue.length, 2);
                } else {
                    assert.equal(
                        stateRef.current?.currentTrack?.id,
                        current.id,
                    );
                    assert.deepEqual(
                        stateRef.current?.currentTrack?.musicSourceRecording,
                        current.musicSourceRecording,
                    );
                    assert.equal(
                        stateRef.current?.currentTrack?.recommendationSessionId,
                        "selected-occurrence",
                    );
                    assert.equal(stateRef.current?.currentIndex, 1);
                    assert.equal(stateRef.current?.queue.length, 2);
                    assert.equal(
                        localStorage.getItem("soundspan_current_time"),
                        "73",
                    );
                    assert.equal(
                        localStorage.getItem("soundspan_current_time_track_id"),
                        current.id,
                    );
                }
            } finally {
                await React.act(async () => root.unmount());
                container.remove();
                getState.mock.restore();
                getTrack.mock.restore();
                clear.mock.restore();
                localStorage.clear();
            }
        });
    }

    test(`${provider} restored public recording reaches the existing source lease without reusing a signed URL`, async () => {
        const { api } = await import("../../lib/api");
        const { createPlaybackSourceLeaseController } =
            await import("../../components/player/hooks/playbackSourceLeaseController");
        const { startTrackPlaybackSourceLease } =
            await import("../../components/player/hooks/startTrackPlaybackSourceLease");
        const track = toMusicSourcePlaybackTrack({
            provider,
            id: provider === "vk" ? "-12_34" : "123",
            title: "Song",
            artists: ["First", "Second"],
            duration: 180,
            contentVersion: "explicit",
            preview: false,
        });
        const url = `/api/music-sources/leases/${"a".repeat(48)}/stream`;
        const resolve = mock.method(
            api,
            "resolveMusicSourcePlayback",
            async () => url,
        );
        const controller = createPlaybackSourceLeaseController(),
            ready: string[] = [],
            errors: unknown[] = [];
        try {
            startTrackPlaybackSourceLease({
                controller,
                track: JSON.parse(JSON.stringify(track)),
                networkUrl: api.getMusicSourceStreamUrl(
                    provider,
                    track.provider!.providerTrackId!,
                ),
                isCurrent: () => true,
                onReady: (value) => ready.push(value),
                onError: (error) => errors.push(error),
            });
            await new Promise<void>((complete) => setImmediate(complete));
            assert.deepEqual(errors, []);
            assert.deepEqual(ready, [url]);
            assert.equal(resolve.mock.callCount(), 1);
            assert.deepEqual(
                resolve.mock.calls[0].arguments[0],
                track.musicSourceRecording,
            );
        } finally {
            controller.release();
            resolve.mock.restore();
        }
    });
}
