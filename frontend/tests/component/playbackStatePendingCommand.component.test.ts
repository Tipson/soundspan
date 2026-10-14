import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
    getExplicitPlaybackCommandGeneration,
    getPlaybackIntentGeneration,
    getExplicitPlaybackPauseGeneration,
} from "../../lib/audio-engine/playbackAdvanceOrigin";
import { audioSeekEmitter } from "../../lib/audio-seek-emitter";
import { setListenTogetherSessionSnapshot } from "../../lib/listen-together-session";
import { listenTogetherSocket } from "../../lib/listen-together-socket";

before(() => {
    GlobalRegistrator.register({ url: "https://soundspan.test/" });
    (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
});
after(() => GlobalRegistrator.unregister());

interface SavedState {
    currentIndex: number;
    isPlaying: boolean;
}
function response(etag: string, state: unknown = null) {
    return Response.json(state, {
        headers: { "X-Playback-State-Protocol": "1", ETag: etag },
    });
}
const revisionA = '"ps1.11111111-1111-4111-8111-111111111111"';
const revisionB = '"ps1.22222222-2222-4222-8222-222222222222"';

async function mountDuplicates() {
    localStorage.clear();
    const track = {
        id: "duplicate-track",
        title: "Duplicate",
        artist: { name: "Artist" },
        album: { title: "Album" },
        duration: 180,
    };
    const queue = [
        { ...track, playlistItemId: "occurrence-0" },
        { ...track, id: "bridge" },
        { ...track, playlistItemId: "occurrence-2" },
    ];
    localStorage.setItem("soundspan_current_track", JSON.stringify(queue[0]));
    localStorage.setItem("soundspan_queue", JSON.stringify(queue));
    localStorage.setItem("soundspan_current_index", "0");
    localStorage.setItem("soundspan_playback_type", "track");
    localStorage.setItem("soundspan_is_playing", "true");
    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider, useAudioState } =
        await import("../../lib/audio-state-context");
    const { AudioPlaybackProvider, usePlaybackStatus } =
        await import("../../lib/audio-playback-context");
    const { AudioControlsProvider, useAudioControls } =
        await import("../../lib/audio-controls-context");
    let state!: ReturnType<typeof useAudioState>;
    let status!: ReturnType<typeof usePlaybackStatus>;
    let controls!: ReturnType<typeof useAudioControls>;
    function Probe() {
        state = useAudioState();
        status = usePlaybackStatus();
        controls = useAudioControls();
        return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    await React.act(async () =>
        root.render(
            React.createElement(
                AudioStateProvider,
                null,
                React.createElement(
                    AudioPlaybackProvider,
                    null,
                    React.createElement(
                        AudioControlsProvider,
                        null,
                        React.createElement(Probe),
                    ),
                ),
            ),
        ),
    );
    return {
        state: () => state,
        status: () => status,
        controls: () => controls,
        async close() {
            await React.act(async () => root.unmount());
            container.remove();
            localStorage.clear();
        },
    };
}

test("same-ID selection followed by pagehide before commit cannot save the previous occurrence with fresh authority", async (t) => {
    const posts: { state: SavedState; commandGeneration: number }[] = [];
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            if (options.method === "POST") {
                posts.push({
                    state: JSON.parse(String(options.body)),
                    commandGeneration: getExplicitPlaybackCommandGeneration(),
                });
                if (posts.length === 1)
                    return Response.json({ error: "stale" }, { status: 412 });
                return response(revisionB, { success: true });
            }
            return response(posts.length === 0 ? revisionA : revisionB);
        },
    );
    const h = await mountDuplicates();
    try {
        assert.equal(posts.length, 1);
        const before = getExplicitPlaybackCommandGeneration();
        await React.act(async () => {
            h.controls().playQueueIndex(2);
            assert.equal(
                h.state().currentIndex,
                0,
                "the command is dispatched before React commits it",
            );
            window.dispatchEvent(new Event("pagehide"));
        });
        assert.ok(getExplicitPlaybackCommandGeneration() > before);
        assert.equal(h.state().currentIndex, 2);
        assert.equal(h.status().isPlaying, true);
        assert.equal(
            posts.length,
            1,
            "skip the old callback until the new command commits",
        );
        await React.act(async () =>
            window.dispatchEvent(new Event("pagehide")),
        );
        assert.equal(posts.length, 2);
        assert.equal(posts[1].state.currentIndex, 2);
        assert.equal(posts[1].state.isPlaying, true);
    } finally {
        await h.close();
    }
});

test("a held old-command save cannot acknowledge progress after a same-ID selection commits", async (t) => {
    let release!: (value: Response) => void;
    const held = new Promise<Response>((resolve) => {
        release = resolve;
    });
    const posts: SavedState[] = [];
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            if (options.method === "POST") {
                posts.push(JSON.parse(String(options.body)));
                return posts.length === 1
                    ? held
                    : response(revisionB, { success: true });
            }
            return response(revisionA);
        },
    );
    const h = await mountDuplicates();
    try {
        assert.equal(posts.length, 1);
        await React.act(async () => h.controls().playQueueIndex(2));
        assert.equal(h.state().currentIndex, 2);
        assert.equal(h.status().isPlaying, true);
        await React.act(async () =>
            release(response(revisionB, { success: true })),
        );
        assert.equal(
            localStorage.getItem("soundspan_last_playback_state_save_at"),
            null,
            "the old command cannot stamp the new selection's acknowledgement",
        );
        await React.act(async () =>
            window.dispatchEvent(new Event("pagehide")),
        );
        assert.equal(posts.length, 2);
        assert.equal(posts[1].currentIndex, 2);
        assert.equal(posts[1].isPlaying, true);
        assert.ok(
            localStorage.getItem("soundspan_last_playback_state_save_at"),
        );
    } finally {
        release(response(revisionB, { success: true }));
        await h.close();
    }
});

for (const suppressListenTogetherBroadcast of [false, true]) {
    test(`automatic pause cannot renew a 412-retired writer; explicit pause can (broadcast suppressed: ${suppressListenTogetherBroadcast})`, async (t) => {
        let posts = 0;
        t.mock.method(
            globalThis,
            "fetch",
            async (_url: unknown, options: RequestInit) => {
                if (options.method === "POST") {
                    posts++;
                    if (posts === 1)
                        return Response.json(
                            { error: "another tab won" },
                            { status: 412 },
                        );
                    return response(revisionB, { success: true });
                }
                return response(posts === 0 ? revisionA : revisionB);
            },
        );
        const h = await mountDuplicates();
        try {
            assert.equal(posts, 1);
            await React.act(async () => h.status().setIsPlaying(true));
            const before = {
                command: getExplicitPlaybackCommandGeneration(),
                intent: getPlaybackIntentGeneration(),
                pause: getExplicitPlaybackPauseGeneration(),
            };
            await React.act(async () =>
                h.controls().pause({
                    origin: "automatic",
                    suppressListenTogetherBroadcast,
                }),
            );
            assert.equal(h.status().isPlaying, false);
            assert.equal(
                getPlaybackIntentGeneration(),
                before.intent + 1,
                "automatic pause retains the existing broad intent fence",
            );
            assert.ok(
                getExplicitPlaybackPauseGeneration() > before.pause,
                "automatic pause retains the existing restart-suppression marker",
            );
            assert.equal(
                getExplicitPlaybackCommandGeneration(),
                before.command,
            );
            assert.equal(
                posts,
                1,
                "a natural-end or remote-apply pause cannot reacquire the winning lease",
            );
            await React.act(async () => h.status().setIsPlaying(true));
            await React.act(async () => h.controls().pause());
            assert.equal(h.status().isPlaying, false);
            assert.ok(getExplicitPlaybackCommandGeneration() > before.command);
            assert.equal(
                posts,
                2,
                "the default UI/media-session pause remains a fresh explicit command",
            );
        } finally {
            await h.close();
        }
    });
}

for (const action of ["seek", "resume-playing", "resume-paused"] as const) {
    test(`automatic remote ${action} preserves a 412 barrier and engine-facing effects`, async (t) => {
        let remoteGroupActive = false;
        t.mock.getter(
            listenTogetherSocket,
            "hasActiveGroup",
            () => remoteGroupActive,
        );
        t.mock.getter(listenTogetherSocket, "activeGroupId", () =>
            remoteGroupActive ? "fixture-group" : null,
        );
        let posts = 0;
        t.mock.method(
            globalThis,
            "fetch",
            async (_url: unknown, options: RequestInit) => {
                if (options.method === "POST") {
                    posts++;
                    if (posts === 1)
                        return Response.json(
                            { error: "another tab won" },
                            { status: 412 },
                        );
                    return response(revisionB, { success: true });
                }
                return response(posts === 0 ? revisionA : revisionB);
            },
        );
        const h = await mountDuplicates();
        const seeks: number[] = [];
        const unsubscribe = audioSeekEmitter.subscribe((time) =>
            seeks.push(time),
        );
        try {
            assert.equal(posts, 1);
            const before = {
                command: getExplicitPlaybackCommandGeneration(),
                intent: getPlaybackIntentGeneration(),
                pause: getExplicitPlaybackPauseGeneration(),
            };
            if (action === "seek")
                await React.act(async () =>
                    h.controls().seek(50, {
                        origin: "automatic",
                        allowListenTogetherFollower: true,
                        suppressListenTogetherBroadcast: true,
                    }),
                );
            else {
                remoteGroupActive = true;
                setListenTogetherSessionSnapshot({
                    groupId: "fixture-group",
                    isHost: false,
                    playback: {
                        isPlaying: action === "resume-playing",
                        positionMs: 50_000,
                        serverTime: Date.now(),
                        currentIndex: 0,
                    },
                });
                await React.act(async () =>
                    h.controls().resume({
                        origin: "automatic",
                        suppressListenTogetherBroadcast: true,
                    }),
                );
                assert.equal(h.status().isPlaying, action === "resume-playing");
                if (action === "resume-paused")
                    assert.ok(
                        getExplicitPlaybackPauseGeneration() > before.pause,
                    );
                else assert.equal(getExplicitPlaybackPauseGeneration(), 0);
            }
            assert.ok(
                getPlaybackIntentGeneration() > before.intent,
                "remote application retains the existing broad intent fences",
            );
            assert.equal(
                getExplicitPlaybackCommandGeneration(),
                before.command,
            );
            assert.ok(
                seeks.length > 0 && seeks[0] >= 50 && seeks[0] < 51,
                "seek listeners receive the original target time",
            );
            await React.act(async () =>
                window.dispatchEvent(new Event("pagehide")),
            );
            assert.equal(posts, 1);
            setListenTogetherSessionSnapshot(null);
            remoteGroupActive = false;
            await React.act(async () => h.status().setIsPlaying(false));
            if (action === "seek")
                await React.act(async () => h.controls().seek(75));
            else await React.act(async () => h.controls().resume());
            if (posts === 1)
                await React.act(async () =>
                    window.dispatchEvent(new Event("pagehide")),
                );
            assert.ok(getExplicitPlaybackCommandGeneration() > before.command);
            assert.ok(posts > 1, "a default user command can renew the writer");
        } finally {
            unsubscribe();
            setListenTogetherSessionSnapshot(null);
            await h.close();
        }
    });
}
