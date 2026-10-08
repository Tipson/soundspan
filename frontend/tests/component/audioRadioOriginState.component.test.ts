import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PlaybackRadioOrigin } from "@soundspan/media-metadata-contract";

before(() => {
    GlobalRegistrator.register();
    (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
});
after(() => GlobalRegistrator.unregister());

const origins: PlaybackRadioOrigin[] = [
    { kind: "track", source: "youtube", id: "original001" },
    { kind: "track", source: "library", id: "original" },
    { kind: "artist", source: "library", id: "artist" },
    { kind: "artist", source: "discovery", name: "Original Artist" },
];

for (const remote of [false, true]) {
    test(`${remote ? "remote" : "local"} restore never copies radio intent from another occurrence of the same song`, async () => {
        localStorage.clear();
        const { api } = await import("../../lib/api");
        const { AudioStateProvider, useAudioState } =
            await import("../../lib/audio-state-context");
        const { createRoot } = await import("react-dom/client");
        const current = {
            id: remote ? "yt:nextVideo01" : "same-id",
            title: "Next",
            duration: 180,
            artist: { name: "Artist" },
            album: { title: "Album" },
            ...(remote
                ? {
                      streamSource: "youtube" as const,
                      youtubeVideoId: "nextVideo01",
                  }
                : {}),
        };
        const queue = [
            { ...current, radioOrigin: origins[0] },
            { ...current, id: "bridge" },
            current,
        ];
        const getState = mock.method(api, "getPlaybackState", async () => ({
            playbackType: "track",
            trackId: current.id,
            queue,
            currentIndex: 2,
            currentTime: 73,
            isPlaying: false,
            updatedAt: new Date().toISOString(),
        }));
        const getTrack = mock.method(api, "getTrack", async () => current);
        const stateRef: { current: ReturnType<typeof useAudioState> | null } = {
            current: null,
        };
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
            assert.equal(stateRef.current?.currentIndex, 2);
            assert.equal(
                stateRef.current?.currentTrack?.radioOrigin,
                undefined,
            );
            assert.deepEqual(
                (stateRef.current?.queue[0] as { radioOrigin?: unknown })
                    .radioOrigin,
                origins[0],
            );
        } finally {
            await React.act(async () => root.unmount());
            container.remove();
            getState.mock.restore();
            getTrack.mock.restore();
            localStorage.clear();
        }
    });
}

for (const origin of origins) {
    for (const fromServer of [false, true]) {
        test(`${origin.kind}/${origin.source} radio survives ${fromServer ? "server" : "local"} restoration after song advancement`, async () => {
            localStorage.clear();
            const { api } = await import("../../lib/api");
            const { AudioStateProvider, useAudioState } =
                await import("../../lib/audio-state-context");
            const { createRoot } = await import("react-dom/client");
            const remote =
                origin.source === "youtube" || origin.source === "discovery";
            const next = {
                id: remote ? "yt:next" : "local-next",
                title: "Next",
                duration: 180,
                artist: { name: "Different Artist" },
                album: { title: "Album" },
                ...(remote
                    ? {
                          streamSource: "youtube" as const,
                          youtubeVideoId: "next",
                      }
                    : {}),
                radioOrigin: origin,
            };
            const queue = [
                { ...next, id: remote ? "yt:original" : "original" },
                next,
            ];
            if (!fromServer) {
                localStorage.setItem("soundspan_queue", JSON.stringify(queue));
                localStorage.setItem(
                    "soundspan_current_track",
                    JSON.stringify(next),
                );
                localStorage.setItem("soundspan_playback_type", "track");
                localStorage.setItem("soundspan_current_index", "1");
            }
            const getState = mock.method(api, "getPlaybackState", async () =>
                fromServer
                    ? {
                          playbackType: "track",
                          trackId: next.id,
                          queue,
                          currentIndex: 1,
                          currentTime: 73,
                          isShuffle: false,
                          isPlaying: false,
                          updatedAt: new Date().toISOString(),
                      }
                    : null,
            );
            const getTrack = mock.method(api, "getTrack", async () => {
                const { radioOrigin: omitted, ...libraryTrack } = next;
                void omitted;
                return libraryTrack;
            });
            const stateRef: {
                current: ReturnType<typeof useAudioState> | null;
            } = { current: null };
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
                assert.equal(stateRef.current?.currentIndex, 1);
                assert.equal(stateRef.current?.currentTrack?.id, next.id);
                assert.deepEqual(
                    stateRef.current?.currentTrack?.radioOrigin,
                    origin,
                );
                for (const row of stateRef.current?.queue ?? []) {
                    assert.ok(row.itemType !== "episode");
                    assert.deepEqual(row.radioOrigin, origin);
                }
                assert.equal(
                    getTrack.mock.callCount(),
                    fromServer && !remote ? 1 : 0,
                );
            } finally {
                await React.act(async () => root.unmount());
                container.remove();
                getState.mock.restore();
                getTrack.mock.restore();
                localStorage.clear();
            }
        });
    }
}

test("current-track local snapshot uses the same radio allowlist as its queue occurrence", async () => {
    localStorage.clear();
    const { api } = await import("../../lib/api");
    const { AudioStateProvider, useAudioState } =
        await import("../../lib/audio-state-context");
    const { createRoot } = await import("react-dom/client");
    const origin = {
        kind: "artist" as const,
        source: "discovery" as const,
        name: "Original",
        secret: "discard",
    };
    const track = {
        id: "yt:next",
        title: "Next",
        duration: 180,
        artist: { name: "Other" },
        album: { title: "Album" },
        radioOrigin: origin,
    };
    localStorage.setItem("soundspan_current_track", JSON.stringify(track));
    localStorage.setItem("soundspan_queue", JSON.stringify([track]));
    const getState = mock.method(api, "getPlaybackState", async () => null);
    const stateRef: { current: ReturnType<typeof useAudioState> | null } = {
        current: null,
    };
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
        assert.deepEqual(stateRef.current?.currentTrack?.radioOrigin, {
            kind: "artist",
            source: "discovery",
            name: "Original",
        });
        assert.deepEqual(
            stateRef.current?.currentTrack?.radioOrigin,
            (stateRef.current?.queue[0] as { radioOrigin?: unknown })
                .radioOrigin,
        );
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
        getState.mock.restore();
        localStorage.clear();
    }
});
