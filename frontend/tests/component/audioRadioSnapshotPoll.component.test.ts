import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PlaybackRadioOrigin } from "@soundspan/media-metadata-contract";
import type { Track, useAudioState } from "../../lib/audio-state-context";
import {
    getExplicitPlaybackPauseGeneration,
    getPlaybackIntentGeneration,
    getPlaybackReplacementGeneration,
    getQueueReplacementGeneration,
    recordExplicitPlaybackPause,
    recordExplicitPlaybackSeek,
    reservePlaybackIntent,
} from "../../lib/audio-engine/playbackAdvanceOrigin";
import type { VibeModeStartResult } from "../../lib/audio-controls-types";
import type { OriginalRadioContinuationResponse } from "../../lib/radio/originalRadioContinuation";

before(() => {
    GlobalRegistrator.register();
    (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
});
after(() => GlobalRegistrator.unregister());

const originA: PlaybackRadioOrigin = {
    kind: "artist",
    source: "library",
    id: "artist-a",
};
const originB: PlaybackRadioOrigin = {
    kind: "artist",
    source: "discovery",
    name: "Artist B",
};
const song = {
    id: "same-song",
    title: "Local title",
    duration: 180,
    artist: { name: "Local Artist" },
    album: { title: "Local Album" },
    radioOrigin: originA,
    source: "local" as const,
    filePath: "local.mp3",
    recommendationGenerationId: "local-generation",
    recommendationSessionId: "local-session",
    recommendationQueueMode: "finite" as const,
};
const initialQueue = [song, { ...song, id: "bridge" }, song];
type AudioState = ReturnType<typeof useAudioState>;

async function withPoll(
    run: (h: {
        state(): AudioState;
        readCount(): number;
        reply: Record<string, unknown>;
        poll(reply?: Record<string, unknown>): Promise<void>;
        held(): Promise<(reply?: Record<string, unknown>) => Promise<void>>;
        changeSession(): void;
        setSocketActive(): void;
        startVibeMode(): Promise<VibeModeStartResult>;
    }) => Promise<void>,
    options: { empty?: boolean } = {},
) {
    localStorage.clear();
    if (!options.empty) {
        localStorage.setItem("soundspan_current_track", JSON.stringify(song));
        localStorage.setItem("soundspan_queue", JSON.stringify(initialQueue));
        localStorage.setItem("soundspan_playback_type", "track");
    }
    localStorage.setItem("soundspan_current_index", "2");
    localStorage.setItem("soundspan_current_time", "73");
    localStorage.setItem("soundspan_current_time_track_id", song.id);
    localStorage.setItem("soundspan_is_playing", "false");
    localStorage.setItem(
        "soundspan_last_playback_state_save_at",
        String(Date.now() - 60000),
    );
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const { api } = await import("../../lib/api");
    const { AudioStateProvider, useAudioState } =
        await import("../../lib/audio-state-context");
    const { createRoot } = await import("react-dom/client");
    const { useVibeModeControls } =
        await import("../../lib/audio/useVibeModeControls");
    const membership = await import("../../lib/listen-together-session");
    const { listenTogetherSocket } =
        await import("../../lib/listen-together-socket");
    let socketActive = false;
    const activeGroup = mock.getter(
        listenTogetherSocket,
        "hasActiveGroup",
        () => socketActive,
    );
    let session = 1;
    const getSession = mock.method(api, "getSessionGeneration", () => session);
    const getState = mock.method(api, "getPlaybackState", async () => null);
    const getTrack = mock.method(api, "getTrack", async () => {
        throw new Error("Metadata poll must not hydrate library media");
    });
    const save = mock.method(api, "savePlaybackState", async () => undefined);
    let state!: AudioState;
    let startVibeMode!: () => Promise<VibeModeStartResult>;
    function Probe() {
        state = useAudioState();
        ({ startVibeMode } = useVibeModeControls({
            state,
            getActiveListenTogetherSession: () => null,
            showQueueMutationToasts: () => undefined,
        }));
        return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    const reply: Record<string, unknown> = {
        playbackType: "track",
        trackId: song.id,
        currentIndex: 2,
        queue: initialQueue.map((row, index) => ({
            ...row,
            title: "Server title",
            filePath: "other.mp3",
            recommendationGenerationId: "server-generation",
            radioOrigin:
                index === 0
                    ? {
                          kind: "track",
                          source: "library",
                          id: "different-occurrence",
                      }
                    : originB,
        })),
        currentTime: 999,
        isPlaying: true,
        isShuffle: true,
        updatedAt: new Date(Date.now() + 1000).toISOString(),
    };
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
        await React.act(async () => {
            mock.timers.tick(8000);
        });
        await run({
            state: () => state,
            startVibeMode: () => startVibeMode(),
            readCount: () => getState.mock.callCount(),
            reply,
            changeSession: () => {
                session += 1;
            },
            setSocketActive: () => {
                socketActive = true;
            },
            async poll(value = reply) {
                getState.mock.mockImplementation(async () => value);
                await React.act(async () => {
                    mock.timers.tick(30000);
                });
            },
            async held() {
                let release!: (value: Record<string, unknown>) => void;
                getState.mock.mockImplementation(
                    () =>
                        new Promise((resolve) => {
                            release = resolve;
                        }),
                );
                await React.act(async () => {
                    mock.timers.tick(30000);
                });
                assert.equal(getState.mock.callCount(), 2);
                return async (value = reply) => {
                    await React.act(async () => release(value));
                };
            },
        });
        assert.equal(getTrack.mock.callCount(), 0);
        assert.equal(save.mock.callCount(), 0);
        assert.equal(localStorage.getItem("soundspan_current_time"), "73");
        assert.equal(localStorage.getItem("soundspan_is_playing"), "false");
    } finally {
        await React.act(async () => root.unmount());
        membership.setListenTogetherSessionSnapshot(null);
        membership.setListenTogetherMembershipPending(false);
        container.remove();
        getState.mock.restore();
        getTrack.mock.restore();
        save.mock.restore();
        getSession.mock.restore();
        activeGroup.mock.restore();
        mock.timers.reset();
        localStorage.clear();
    }
}

for (const provider of ["vk", "yandex"] as const) {
    for (const change of [
        "selection",
        "group",
        "session",
        "pause",
        "local write",
        "socket",
        "group join and leave",
    ] as const) {
        test(`held ${provider} different-media poll cannot overwrite newer ${change}`, async () => {
            await withPoll(
                async (h) => {
                    const { toMusicSourcePlaybackTrack } =
                        await import("../../lib/audio/musicSourcePlayback");
                    const remote = toMusicSourcePlaybackTrack({
                        provider,
                        id: provider === "vk" ? "-12_34" : "123",
                        title: "Remote song",
                        artists: ["Remote Artist"],
                        duration: 180,
                        contentVersion: "unknown",
                        preview: false,
                    });
                    const release = await h.held();
                    await React.act(async () => {
                        if (change === "selection") {
                            h.state().setCurrentTrack(song);
                            h.state().setQueue([song]);
                            h.state().setPlaybackType("track");
                            h.state().setCurrentIndex(0);
                        }
                        if (change === "session") h.changeSession();
                        if (change === "pause") recordExplicitPlaybackPause();
                        if (change === "socket") h.setSocketActive();
                        if (change === "local write")
                            localStorage.setItem(
                                "soundspan_last_playback_state_save_at",
                                String(Date.now()),
                            );
                        if (change.startsWith("group")) {
                            const membership =
                                await import("../../lib/listen-together-session");
                            membership.setListenTogetherMembershipPending(true);
                            if (change === "group join and leave")
                                membership.setListenTogetherMembershipPending(
                                    false,
                                );
                        }
                    });
                    const latest = h.state();
                    await release({
                        ...h.reply,
                        trackId: remote.id,
                        queue: [remote],
                        currentIndex: 0,
                    });
                    assert.equal(h.state().currentTrack, latest.currentTrack);
                    assert.equal(h.state().queue, latest.queue);
                    assert.equal(h.state().playbackType, latest.playbackType);
                    assert.equal(h.state().currentIndex, latest.currentIndex);
                    assert.equal(
                        h.state().lastServerSync,
                        latest.lastServerSync,
                    );
                },
                { empty: true },
            );
        });
    }
    for (const queueMode of ["finite", "wave"] as const) {
        test(`fresh ${provider} poll restores the selected duplicate occurrence and ${queueMode} mode`, async () => {
            await withPoll(
                async (h) => {
                    const { toMusicSourcePlaybackTrack } =
                        await import("../../lib/audio/musicSourcePlayback");
                    const remote = toMusicSourcePlaybackTrack({
                        provider,
                        id: provider === "vk" ? "-12_34" : "123",
                        title: "Remote song",
                        artists: ["Remote Artist"],
                        duration: 180,
                        contentVersion: "unknown",
                        preview: false,
                    });
                    const selected = {
                        ...remote,
                        radioOrigin: originB,
                        recommendationGenerationId: "native-generation",
                        recommendationSessionId: "native-session",
                        ...(queueMode === "finite"
                            ? { recommendationQueueMode: "finite" as const }
                            : {}),
                    };
                    const queue = [
                        { ...selected, radioOrigin: originA },
                        {
                            ...toMusicSourcePlaybackTrack({
                                ...remote.musicSourceRecording!,
                                id: provider === "vk" ? "-12_35" : "124",
                            }),
                        },
                        selected,
                    ];
                    await h.poll({
                        ...h.reply,
                        trackId: remote.id,
                        queue,
                        currentIndex: 2,
                        isShuffle: false,
                    });
                    assert.equal(h.state().currentTrack?.id, remote.id);
                    assert.deepEqual(
                        h.state().currentTrack?.musicSourceRecording,
                        remote.musicSourceRecording,
                    );
                    assert.deepEqual(
                        h.state().currentTrack?.radioOrigin,
                        originB,
                    );
                    assert.deepEqual(
                        h.state().queue.map((row) => row.id),
                        queue.map((row) => row.id),
                    );
                    assert.equal(h.state().currentIndex, 2);
                    assert.equal(h.state().vibeMode, queueMode === "wave");
                    assert.deepEqual(
                        h.state().vibeQueueIds,
                        queueMode === "wave" ? queue.map((row) => row.id) : [],
                    );
                    assert.equal(
                        h.state().lastServerSync?.toISOString(),
                        h.reply.updatedAt,
                    );
                },
                { empty: true },
            );
        });
    }
}

for (const result of ["success", "failure"] as const) {
    test(`held library hydration ${result} cannot replace or clear a newer selection`, async () => {
        await withPoll(
            async (h) => {
                const { api } = await import("../../lib/api");
                let resolveTrack!: (track: unknown) => void;
                let rejectTrack!: (error: Error) => void;
                const getTrack = mock.method(
                    api,
                    "getTrack",
                    () =>
                        new Promise((resolve, reject) => {
                            resolveTrack = resolve;
                            rejectTrack = reject;
                        }),
                );
                const clear = mock.method(
                    api,
                    "clearPlaybackState",
                    async () => undefined,
                );
                try {
                    await h.poll({
                        ...h.reply,
                        trackId: "remote-library-song",
                        queue: [],
                        currentIndex: 0,
                    });
                    assert.equal(getTrack.mock.callCount(), 1);
                    await React.act(async () => {
                        h.state().setCurrentTrack(song);
                        h.state().setQueue([song]);
                        h.state().setPlaybackType("track");
                        h.state().setCurrentIndex(0);
                    });
                    const latest = h.state();
                    await React.act(async () => {
                        if (result === "success")
                            resolveTrack({
                                ...song,
                                id: "remote-library-song",
                            });
                        else rejectTrack(new Error("Track no longer exists"));
                    });
                    assert.equal(h.state().currentTrack, latest.currentTrack);
                    assert.equal(h.state().queue, latest.queue);
                    assert.equal(h.state().currentIndex, latest.currentIndex);
                    assert.equal(
                        h.state().lastServerSync,
                        latest.lastServerSync,
                    );
                    assert.equal(clear.mock.callCount(), 0);
                } finally {
                    getTrack.mock.restore();
                    clear.mock.restore();
                }
            },
            { empty: true },
        );
    });
}

test("newer same-ID poll merges only the selected occurrence's station metadata", async () => {
    await withPoll(async (h) => {
        const before = h.state();
        await h.poll();
        assert.equal(h.readCount(), 2);
        const state = h.state();
        assert.deepEqual(state.currentTrack, {
            ...before.currentTrack,
            radioOrigin: originB,
        });
        assert.deepEqual(
            state.queue.map((row) => row.id),
            before.queue.map((row) => row.id),
        );
        assert.deepEqual((state.queue[0] as Track).radioOrigin, {
            kind: "track",
            source: "library",
            id: "different-occurrence",
        });
        assert.deepEqual((state.queue[2] as Track).radioOrigin, originB);
        assert.equal(state.currentIndex, 2);
        assert.equal(state.isShuffle, false);
        assert.equal(state.vibeMode, false);
        assert.deepEqual(state.vibeQueueIds, before.vibeQueueIds);
        assert.equal(state.lastServerSync?.toISOString(), h.reply.updatedAt);
    });
});

test("same-ID poll honors an explicit station clear and equal clones keep object identity", async () => {
    await withPoll(async (h) => {
        const before = h.state();
        await h.poll({
            ...h.reply,
            queue: initialQueue.map((row) => ({
                ...row,
                radioOrigin: { ...originA },
            })),
        });
        assert.equal(h.state().currentTrack, before.currentTrack);
        assert.equal(h.state().queue, before.queue);
        await h.poll({
            ...h.reply,
            updatedAt: new Date(Date.now() + 2000).toISOString(),
            queue: initialQueue.map(({ radioOrigin: omitted, ...row }) => {
                void omitted;
                return row;
            }),
        });
        assert.equal(h.state().currentTrack?.radioOrigin, undefined);
        assert.ok(h.state().queue.every((row) => !("radioOrigin" in row)));
    });
});

test("an enqueued queue append in the same React batch cancels the metadata transaction", async () => {
    await withPoll(async (h) => {
        const release = await h.held();
        const before = h.state();
        await React.act(async () => {
            before.setQueue((queue) => [
                ...queue,
                { ...song, id: "pending-tail" },
            ]);
            await release();
        });
        assert.equal(h.state().queue.length, 4);
        assert.equal(h.state().queue[3].id, "pending-tail");
        assert.equal(h.state().currentTrack, before.currentTrack);
        assert.equal(h.state().lastServerSync, before.lastServerSync);
    });
});

test("accepted metadata retires an old radio answer before React commits either update", async () => {
    await withPoll(async (h) => {
        const { api } = await import("../../lib/api");
        let resolveRadio!: (
            response: OriginalRadioContinuationResponse,
        ) => void;
        const radio = mock.method(
            api,
            "getRadioContinuation",
            () =>
                new Promise<OriginalRadioContinuationResponse>((resolve) => {
                    resolveRadio = resolve;
                }),
        );
        try {
            const pending = h.startVibeMode();
            const release = await h.held();
            const before = {
                intent: getPlaybackIntentGeneration(),
                replacement: getPlaybackReplacementGeneration(),
                pause: getExplicitPlaybackPauseGeneration(),
                queue: getQueueReplacementGeneration(),
            };
            let result!: VibeModeStartResult;
            await React.act(async () => {
                await release();
                resolveRadio({
                    radioOrigin: originA,
                    generationId: "old-generation",
                    nextCursor: 1,
                    tracks: [
                        {
                            ...song,
                            id: "old-radio-tail",
                            source: "library",
                            provider: {
                                youtubeVideoId: null,
                                tidalTrackId: null,
                            },
                        },
                    ],
                    degraded: false,
                    degradedSources: [],
                });
                result = await pending;
            });
            assert.equal(result.success, false);
            assert.equal(radio.mock.callCount(), 1);
            assert.deepEqual(
                h.state().queue.map((row) => row.id),
                initialQueue.map((row) => row.id),
            );
            assert.deepEqual(h.state().currentTrack?.radioOrigin, originB);
            assert.equal(getQueueReplacementGeneration(), before.queue + 1);
            assert.equal(getPlaybackIntentGeneration(), before.intent);
            assert.equal(
                getPlaybackReplacementGeneration(),
                before.replacement,
            );
            assert.equal(getExplicitPlaybackPauseGeneration(), before.pause);
        } finally {
            radio.mock.restore();
        }
    });
});

for (const field of [
    "track",
    "index",
    "shuffle",
    "shuffle indices",
    "vibe",
    "type",
    "sync",
    "no-op",
]) {
    test(`an uncommitted ${field} dispatch cancels both halves of the metadata transaction`, async () => {
        await withPoll(async (h) => {
            const release = await h.held();
            const before = h.state();
            await React.act(async () => {
                if (field === "track")
                    before.setCurrentTrack({
                        ...song,
                        title: "New local title",
                    });
                if (field === "index") before.setCurrentIndex(0);
                if (field === "shuffle") before.setIsShuffle(true);
                if (field === "shuffle indices")
                    before.setShuffleIndices([2, 1, 0]);
                if (field === "vibe") before.setVibeMode(true);
                if (field === "type") before.setPlaybackType("podcast");
                if (field === "sync")
                    before.setLastServerSync(new Date(Date.now() + 2000));
                if (field === "no-op") before.setQueue((queue) => queue);
                await release();
            });
            assert.equal(
                h.state().currentTrack?.radioOrigin?.source,
                "library",
            );
            assert.equal(h.state().queue, before.queue);
            if (field !== "sync") assert.equal(h.state().lastServerSync, null);
            if (field === "no-op") {
                await h.poll();
                assert.deepEqual(
                    h.state().currentTrack?.radioOrigin,
                    originB,
                    "a no-op dispatch must not disable later fresh polls",
                );
            }
        });
    });
}

for (const [name, modify] of Object.entries<
    (reply: Record<string, unknown>) => Record<string, unknown>
>({
    truncated: (r) => ({ ...r, queue: (r.queue as unknown[]).slice(0, 2) }),
    reordered: (r) => ({
        ...r,
        queue: [initialQueue[1], initialQueue[0], initialQueue[2]],
    }),
    "other duplicate occurrence": (r) => ({ ...r, currentIndex: 0 }),
    "missing selection": (r) => ({ ...r, currentIndex: undefined }),
    "invalid timestamp": (r) => ({ ...r, updatedAt: "invalid" }),
    "older timestamp": (r) => ({ ...r, updatedAt: new Date(1).toISOString() }),
    "malformed origin": (r) => ({
        ...r,
        queue: initialQueue.map((row) => ({
            ...row,
            radioOrigin: { kind: "track", source: "tidal", id: "bad" },
        })),
    }),
    "invalid extra row": (r) => ({
        ...r,
        queue: [...(r.queue as unknown[]), { id: "" }],
    }),
    "mixed episode": (r) => ({
        ...r,
        queue: (r.queue as Record<string, unknown>[]).map((row, index) =>
            index === 1
                ? {
                      ...row,
                      itemType: "episode",
                      podcastId: "podcast",
                      episodeId: "episode",
                  }
                : row,
        ),
    }),
})) {
    test(`same-ID poll rejects ${name} without queue or track mutation`, async () => {
        await withPoll(async (h) => {
            const before = h.state();
            await h.poll(modify(h.reply));
            assert.equal(h.state().currentTrack, before.currentTrack);
            assert.equal(h.state().queue, before.queue);
            assert.equal(h.state().currentIndex, 2);
        });
    });
}

for (const name of [
    "queue",
    "station",
    "index",
    "shuffle",
    "vibe",
    "pause",
    "seek",
    "replacement",
    "session",
    "owner",
    "group",
    "group join and leave",
    "active socket before snapshot",
    "local write",
    "sync timestamp",
]) {
    test(`held same-ID poll cannot overwrite a newer ${name}`, async () => {
        await withPoll(async (h) => {
            const release = await h.held();
            await React.act(async () => {
                const s = h.state();
                if (name === "queue")
                    s.setQueue([...s.queue, { ...song, id: "new" }]);
                if (name === "station") {
                    const local = {
                        kind: "track",
                        source: "library",
                        id: "new-local-seed",
                    } as const;
                    s.setQueue(
                        s.queue.map((row) => ({ ...row, radioOrigin: local })),
                    );
                    s.setCurrentTrack({ ...song, radioOrigin: local });
                }
                if (name === "index") s.setCurrentIndex(0);
                if (name === "shuffle") s.setIsShuffle(true);
                if (name === "vibe") s.setVibeMode(true);
                if (name === "sync timestamp")
                    s.setLastServerSync(new Date(Date.now() + 2000));
                if (name === "pause") recordExplicitPlaybackPause();
                if (name === "seek") recordExplicitPlaybackSeek();
                if (name === "replacement") reservePlaybackIntent();
                if (name === "session") h.changeSession();
                if (name === "active socket before snapshot")
                    h.setSocketActive();
                if (name === "owner")
                    (
                        await import("../../lib/userPlaybackStorage")
                    ).revokeUserPlaybackStorage();
                if (name.startsWith("group")) {
                    const membership =
                        await import("../../lib/listen-together-session");
                    membership.setListenTogetherMembershipPending(true);
                    if (name === "group join and leave")
                        membership.setListenTogetherMembershipPending(false);
                }
                if (name === "local write")
                    localStorage.setItem(
                        "soundspan_last_playback_state_save_at",
                        String(Date.now()),
                    );
            });
            const latest = h.state();
            await release();
            assert.equal(h.state().currentTrack, latest.currentTrack);
            assert.equal(h.state().queue, latest.queue);
            assert.equal(h.state().currentIndex, latest.currentIndex);
            assert.equal(h.state().lastServerSync, latest.lastServerSync);
            // Owner revocation intentionally clears its persisted progress keys.
            if (name === "owner") {
                localStorage.setItem("soundspan_current_time", "73");
                localStorage.setItem("soundspan_is_playing", "false");
            }
        });
    });
}
