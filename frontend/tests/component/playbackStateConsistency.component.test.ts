import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { api } from "../../lib/api";
import { recordExplicitPlaybackPause } from "../../lib/audio-engine/playbackAdvanceOrigin";

before(() => {
    GlobalRegistrator.register();
    (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
});
after(() => GlobalRegistrator.unregister());

const oldTrack = {
    id: "old-library",
    title: "Old",
    artist: { name: "Artist" },
    album: { title: "Album" },
    duration: 180,
};
const newTrack = { ...oldTrack, id: "new-library", title: "New" };
const oldState = {
    playbackType: "track",
    trackId: oldTrack.id,
    queue: [oldTrack],
    currentIndex: 0,
    currentTime: 73,
    isPlaying: true,
    updatedAt: new Date(Date.now() + 60_000).toISOString(),
};
const revision = {
    etag: '"ps1.11111111-1111-4111-8111-111111111111"',
    authGeneration: 0,
    deviceId: "test",
};
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}
async function mount(playback = false) {
    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider, useAudioState } =
        await import("../../lib/audio-state-context");
    const { AudioPlaybackProvider, usePlaybackStatus } =
        await import("../../lib/audio-playback-context");
    let state!: ReturnType<typeof useAudioState>;
    let status!: ReturnType<typeof usePlaybackStatus>;
    function Probe() {
        state = useAudioState();
        return null;
    }
    function PlaybackProbe() {
        status = usePlaybackStatus();
        return React.createElement(Probe);
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    await React.act(async () =>
        root.render(
            React.createElement(
                AudioStateProvider,
                null,
                playback
                    ? React.createElement(
                          AudioPlaybackProvider,
                          null,
                          React.createElement(PlaybackProbe),
                      )
                    : React.createElement(Probe),
            ),
        ),
    );
    return {
        state: () => state,
        status: () => status,
        async close() {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

for (const outcome of ["success", "failure"] as const) {
    test(`startup secondary lookup ${outcome} cannot overwrite a newer selection`, async (t) => {
        localStorage.clear();
        const track = deferred<typeof oldTrack>();
        t.mock.method(api, "getPlaybackState", async () => oldState);
        t.mock.method(api, "getPlaybackStateSnapshot", async () => ({
            state: oldState,
            revision,
        }));
        t.mock.method(api, "getTrack", () => track.promise);
        const clear = t.mock.method(
            api,
            "clearPlaybackState",
            async () => true,
        );
        const h = await mount();
        try {
            await React.act(async () => {
                h.state().setCurrentTrack(newTrack);
                h.state().setPlaybackType("track");
                h.state().setQueue([newTrack]);
                h.state().setCurrentIndex(0);
            });
            localStorage.setItem("soundspan_current_time", "0");
            await React.act(async () => {
                if (outcome === "success") track.resolve(oldTrack);
                else track.reject(new Error("Missing old track"));
            });
            assert.equal(h.state().currentTrack?.id, newTrack.id);
            assert.deepEqual(
                h.state().queue.map((row) => row.id),
                [newTrack.id],
            );
            assert.equal(localStorage.getItem("soundspan_current_time"), "0");
            assert.equal(clear.mock.callCount(), 0);
        } finally {
            await h.close();
            localStorage.clear();
        }
    });
}

for (const outcome of ["success", "failure"] as const) {
    for (const command of ["clear", "pause", "group join and leave"] as const) {
        test(`held startup lookup ${outcome} is retired by ${command}`, async (t) => {
            localStorage.clear();
            const track = deferred<typeof oldTrack>();
            t.mock.method(api, "getPlaybackStateSnapshot", async () => ({
                state: oldState,
                revision,
            }));
            t.mock.method(api, "getTrack", () => track.promise);
            const clear = t.mock.method(
                api,
                "clearPlaybackState",
                async () => true,
            );
            const membership =
                await import("../../lib/listen-together-session");
            const h = await mount();
            try {
                await React.act(async () => {
                    if (command === "clear") {
                        h.state().setCurrentTrack(null);
                        h.state().setQueue([]);
                        h.state().setPlaybackType(null);
                    } else if (command === "pause")
                        recordExplicitPlaybackPause();
                    else {
                        membership.setListenTogetherMembershipPending(true);
                        membership.setListenTogetherMembershipPending(false);
                    }
                });
                await React.act(async () => {
                    if (outcome === "success") track.resolve(oldTrack);
                    else track.reject(new Error("Missing old track"));
                });
                assert.equal(h.state().currentTrack, null);
                assert.deepEqual(h.state().queue, []);
                assert.equal(
                    localStorage.getItem("soundspan_current_time"),
                    null,
                );
                assert.equal(clear.mock.callCount(), 0);
            } finally {
                await h.close();
                membership.setListenTogetherMembershipPending(false);
                localStorage.clear();
            }
        });
    }
}

test("startup materializes a library track before adopting queue and position together", async (t) => {
    localStorage.clear();
    const track = deferred<typeof oldTrack>();
    t.mock.method(api, "getPlaybackState", async () => oldState);
    t.mock.method(api, "getPlaybackStateSnapshot", async () => ({
        state: oldState,
        revision,
    }));
    t.mock.method(api, "getTrack", () => track.promise);
    const h = await mount();
    try {
        assert.deepEqual(
            h.state().queue,
            [],
            "a held lookup must not partially adopt the old queue",
        );
        assert.equal(localStorage.getItem("soundspan_current_time"), null);
        await React.act(async () => track.resolve(oldTrack));
        assert.equal(h.state().currentTrack?.id, oldTrack.id);
        assert.equal(h.state().queue[0]?.id, oldTrack.id);
        assert.equal(localStorage.getItem("soundspan_current_time"), "73");
    } finally {
        await h.close();
        localStorage.clear();
    }
});

test("startup secondary lookup cannot regress progress saved while materialization was pending", async (t) => {
    localStorage.clear();
    const track = deferred<typeof oldTrack>();
    t.mock.method(api, "getPlaybackStateSnapshot", async () => ({
        state: oldState,
        revision,
    }));
    t.mock.method(api, "getTrack", () => track.promise);
    const h = await mount();
    try {
        localStorage.setItem("soundspan_current_time", "91.125");
        localStorage.setItem(
            "soundspan_last_playback_state_save_at",
            String(Date.now()),
        );
        await React.act(async () => track.resolve(oldTrack));
        assert.equal(localStorage.getItem("soundspan_current_time"), "91.125");
        assert.equal(h.state().currentTrack, null);
    } finally {
        await h.close();
        localStorage.clear();
    }
});

for (const medium of ["audiobook", "podcast"] as const) {
    for (const changeSelection of [false, true]) {
        test(`held ${medium} progress refresh ${changeSelection ? "cannot repopulate a previous selection" : "updates the same selected medium"}`, async (t) => {
            localStorage.clear();
            const saved = {
                id: medium === "audiobook" ? "saved-book" : "show:episode",
                title: "Saved",
                author: "Author",
                podcastTitle: "Show",
                coverUrl: null,
                duration: 180,
            };
            localStorage.setItem(
                `soundspan_current_${medium}`,
                JSON.stringify(saved),
            );
            localStorage.setItem("soundspan_playback_type", medium);
            const progress = {
                currentTime: 75.125,
                progress: 0.5,
                isFinished: false,
                lastPlayedAt: new Date(),
            };
            const lookup = deferred<unknown>();
            t.mock.method(api, "getPlaybackStateSnapshot", async () => ({
                state: null,
                revision: null,
            }));
            if (medium === "audiobook")
                t.mock.method(api, "getAudiobook", () => lookup.promise);
            else t.mock.method(api, "getPodcast", () => lookup.promise);
            const h = await mount();
            try {
                if (changeSelection)
                    await React.act(async () => {
                        h.state().setCurrentTrack(newTrack);
                        h.state().setCurrentAudiobook(null);
                        h.state().setCurrentPodcast(null);
                        h.state().setPlaybackType("track");
                        h.state().setQueue([newTrack]);
                    });
                await React.act(async () =>
                    lookup.resolve(
                        medium === "audiobook"
                            ? { ...saved, progress }
                            : {
                                  title: "Show",
                                  coverUrl: null,
                                  episodes: [
                                      {
                                          id: "episode",
                                          title: "Saved",
                                          duration: 180,
                                          progress,
                                      },
                                  ],
                              },
                    ),
                );
                const current =
                    medium === "audiobook"
                        ? h.state().currentAudiobook
                        : h.state().currentPodcast;
                if (changeSelection) {
                    assert.equal(current, null);
                    assert.equal(h.state().currentTrack?.id, newTrack.id);
                } else assert.equal(current?.progress?.currentTime, 75.125);
            } finally {
                await h.close();
                localStorage.clear();
            }
        });
    }
}

test("late intent hydration cannot undo an explicit pause", async (t) => {
    localStorage.clear();
    const intent = deferred<typeof oldState>();
    t.mock.method(api, "getPlaybackState", () => intent.promise);
    t.mock.method(api, "getPlaybackStateSnapshot", async () => ({
        state: null,
        revision: null,
    }));
    t.mock.method(api, "savePlaybackState", async () => null);
    const h = await mount(true);
    try {
        await React.act(async () => {
            recordExplicitPlaybackPause();
            h.status().setIsPlaying(false);
            intent.resolve(oldState);
        });
        assert.equal(h.status().isPlaying, false);
    } finally {
        await h.close();
        localStorage.clear();
    }
});

for (const order of ["state-first", "intent-first"] as const) {
    test(`startup ${order} reads preserve the same persisted play intent without a user command`, async (t) => {
        localStorage.clear();
        const stateRead = deferred<{
            state: typeof oldState;
            revision: typeof revision;
        }>();
        const intentRead = deferred<typeof oldState>();
        t.mock.method(api, "getPlaybackStateSnapshot", () => stateRead.promise);
        t.mock.method(api, "getPlaybackState", () => intentRead.promise);
        t.mock.method(api, "getTrack", async () => oldTrack);
        t.mock.method(api, "savePlaybackState", async () => null);
        const h = await mount(true);
        try {
            if (order === "state-first") {
                await React.act(async () =>
                    stateRead.resolve({ state: oldState, revision }),
                );
                await React.act(async () => intentRead.resolve(oldState));
            } else {
                await React.act(async () => intentRead.resolve(oldState));
                await React.act(async () =>
                    stateRead.resolve({ state: oldState, revision }),
                );
            }
            assert.equal(h.status().isPlaying, true);
            assert.equal(h.state().currentTrack?.id, oldTrack.id);
        } finally {
            await h.close();
            localStorage.clear();
        }
    });
}

test("a pause during a held progress save reaches the API coordinator", async (t) => {
    localStorage.clear();
    localStorage.setItem("soundspan_current_track", JSON.stringify(oldTrack));
    localStorage.setItem("soundspan_queue", JSON.stringify([oldTrack]));
    localStorage.setItem("soundspan_playback_type", "track");
    localStorage.setItem("soundspan_is_playing", "true");
    t.mock.method(api, "getPlaybackState", async () => null);
    t.mock.method(api, "getPlaybackStateSnapshot", async () => ({
        state: null,
        revision: null,
    }));
    const active = deferred<null>();
    const saved: Parameters<typeof api.savePlaybackState>[0][] = [];
    let hold = false;
    t.mock.method(
        api,
        "savePlaybackState",
        async (state: Parameters<typeof api.savePlaybackState>[0]) => {
            saved.push(state);
            return hold ? active.promise : null;
        },
    );
    const h = await mount(true);
    try {
        await React.act(async () => h.status().setIsPlaying(true));
        saved.length = 0;
        hold = true;
        await React.act(async () =>
            window.dispatchEvent(new Event("pagehide")),
        );
        assert.equal(saved.length, 1);
        assert.equal(saved[0].isPlaying, true);
        await React.act(async () => {
            recordExplicitPlaybackPause();
            h.status().setIsPlaying(false);
        });
        assert.equal(saved.length, 2);
        assert.equal(
            saved.at(-1)?.isPlaying,
            false,
            "the coordinator must receive pause even while the previous write is pending",
        );
        await React.act(async () => active.resolve(null));
    } finally {
        active.resolve(null);
        await h.close();
        localStorage.clear();
    }
});

test("poll cleanup uses its immutable snapshot and a rejected clear preserves local media", async (t) => {
    localStorage.clear();
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    t.mock.method(api, "getPlaybackState", async () => null);
    const snapshot = { state: oldState, revision };
    let reads = 0;
    t.mock.method(api, "getPlaybackStateSnapshot", async () =>
        ++reads === 1 ? { state: null, revision: null } : snapshot,
    );
    t.mock.method(api, "getTrack", async () => {
        throw new Error("missing");
    });
    const clear = t.mock.method(api, "clearPlaybackState", async () => false);
    const h = await mount();
    try {
        await React.act(async () => {
            h.state().setCurrentTrack(newTrack);
            h.state().setPlaybackType("track");
        });
        await React.act(async () => {
            mock.timers.tick(8000);
        });
        await React.act(async () => {
            mock.timers.tick(30000);
        });
        assert.equal(clear.mock.callCount(), 1);
        assert.equal(clear.mock.calls[0].arguments[0], snapshot);
        assert.equal(h.state().currentTrack?.id, newTrack.id);
        assert.deepEqual(h.state().queue, []);
    } finally {
        await h.close();
        mock.timers.reset();
        localStorage.clear();
    }
});

test("412 followed by station-metadata polling cannot renew a clock-tick writer", async (t) => {
    localStorage.clear();
    const originA = { kind: "artist", source: "library", id: "artist-a" };
    const originB = { kind: "artist", source: "discovery", name: "Artist B" };
    const selected = { ...oldTrack, radioOrigin: originA };
    const queue = [selected, { ...selected, id: "bridge" }, selected];
    localStorage.setItem("soundspan_current_track", JSON.stringify(selected));
    localStorage.setItem("soundspan_queue", JSON.stringify(queue));
    localStorage.setItem("soundspan_playback_type", "track");
    localStorage.setItem("soundspan_current_index", "2");
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let polling = false;
    let posts = 0;
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            if (options.method === "POST") {
                posts++;
                if (posts === 1)
                    return new Response(JSON.stringify({ error: "stale" }), {
                        status: 412,
                    });
            }
            return Response.json(
                {
                    ...oldState,
                    isPlaying: false,
                    currentIndex: 2,
                    queue: polling
                        ? queue.map((row) => ({ ...row, radioOrigin: originB }))
                        : queue,
                },
                {
                    headers: {
                        "X-Playback-State-Protocol": "1",
                        ETag:
                            posts > 1
                                ? '"ps1.33333333-3333-4333-8333-333333333333"'
                                : '"ps1.22222222-2222-4222-8222-222222222222"',
                    },
                },
            );
        },
    );
    const h = await mount(true);
    try {
        assert.equal(posts, 1);
        polling = true;
        await React.act(async () => {
            mock.timers.tick(8000);
        });
        await React.act(async () => {
            mock.timers.tick(30000);
        });
        assert.deepEqual(h.state().currentTrack?.radioOrigin, originB);
        await React.act(async () => h.status().setIsPlaying(true));
        await React.act(async () => {
            mock.timers.tick(15000);
        });
        assert.equal(
            posts,
            1,
            "metadata-generated queue generations must retain the 412 barrier",
        );
        await React.act(async () => {
            recordExplicitPlaybackPause();
            h.status().setIsPlaying(false);
        });
        assert.equal(
            posts,
            2,
            "a new explicit pause may acquire and write with a fresh lease",
        );
    } finally {
        await h.close();
        mock.timers.reset();
        localStorage.clear();
    }
});

test("412 followed by remote-media polling cannot renew an automatic writer", async (t) => {
    localStorage.clear();
    localStorage.setItem("soundspan_current_track", JSON.stringify(oldTrack));
    localStorage.setItem("soundspan_playback_type", "track");
    const remote = {
        ...oldTrack,
        id: "yt:remote-video",
        streamSource: "youtube",
        youtubeVideoId: "remote-video",
    };
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let polling = false;
    let posts = 0;
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            if (options.method === "POST") {
                posts++;
                return new Response(JSON.stringify({ error: "stale" }), {
                    status: 412,
                });
            }
            return Response.json(
                {
                    ...oldState,
                    isPlaying: false,
                    trackId: polling ? remote.id : oldTrack.id,
                    queue: polling ? [remote] : [],
                },
                {
                    headers: {
                        "X-Playback-State-Protocol": "1",
                        ETag: '"ps1.22222222-2222-4222-8222-222222222222"',
                    },
                },
            );
        },
    );
    const h = await mount(true);
    try {
        assert.equal(posts, 1);
        polling = true;
        await React.act(async () => {
            mock.timers.tick(8000);
        });
        await React.act(async () => {
            mock.timers.tick(30000);
        });
        assert.equal(h.state().currentTrack?.id, remote.id);
        await React.act(async () =>
            window.dispatchEvent(new Event("pagehide")),
        );
        assert.equal(posts, 1);
    } finally {
        await h.close();
        mock.timers.reset();
        localStorage.clear();
    }
});

test("skipped progress saves never acknowledge a server save in local storage", async (t) => {
    localStorage.clear();
    localStorage.setItem("soundspan_current_track", JSON.stringify(oldTrack));
    localStorage.setItem("soundspan_queue", JSON.stringify([oldTrack]));
    localStorage.setItem("soundspan_playback_type", "track");
    t.mock.method(api, "getPlaybackState", async () => null);
    t.mock.method(api, "getPlaybackStateSnapshot", async () => ({
        state: null,
        revision: null,
    }));
    t.mock.method(api, "savePlaybackState", async () => undefined);
    const h = await mount(true);
    try {
        await React.act(async () =>
            window.dispatchEvent(new Event("pagehide")),
        );
        assert.equal(
            localStorage.getItem("soundspan_last_playback_state_save_at"),
            null,
        );
        assert.equal(h.state().currentTrack?.id, oldTrack.id);
    } finally {
        await h.close();
        localStorage.clear();
    }
});

test("legacy restore keeps duplicate occurrence and radio metadata in the first full-queue save", async (t) => {
    localStorage.clear();
    const originA = {
        kind: "artist" as const,
        source: "library" as const,
        id: "artist-a",
    };
    const originB = {
        kind: "artist" as const,
        source: "discovery" as const,
        name: "Artist B",
    };
    const remote = {
        ...oldTrack,
        id: "yt:duplicate-video",
        streamSource: "youtube",
        youtubeVideoId: "duplicate-video",
        recommendationQueueMode: "finite",
        radioOrigin: originA,
    };
    const queue = [
        remote,
        { ...remote, id: "yt:bridge-video", youtubeVideoId: "bridge-video" },
        { ...remote, radioOrigin: originB },
    ];
    const posts: Parameters<typeof api.savePlaybackState>[0][] = [];
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            if (options.method === "POST")
                posts.push(JSON.parse(String(options.body)));
            return Response.json(
                {
                    ...oldState,
                    trackId: remote.id,
                    queue,
                    currentIndex: 2,
                    isPlaying: false,
                },
                {
                    headers: {
                        "X-Playback-State-Protocol": "1",
                        ETag:
                            options.method === "POST"
                                ? '"ps1.22222222-2222-4222-8222-222222222222"'
                                : '"ps1.absent"',
                    },
                },
            );
        },
    );
    const h = await mount(true);
    try {
        assert.equal(h.state().currentIndex, 2);
        assert.deepEqual(h.state().currentTrack?.radioOrigin, originB);
        assert.equal(h.state().vibeMode, false);
        assert.ok(posts.length > 0);
        assert.equal(posts[0].queue?.length, 3);
        assert.equal(posts[0].currentIndex, 2);
        assert.deepEqual(posts[0].queue?.[2].radioOrigin, originB);
        assert.deepEqual(posts[0].queue?.[0].radioOrigin, originA);
        assert.equal(posts[0].isPlaying, false);
    } finally {
        await h.close();
        localStorage.clear();
    }
});
