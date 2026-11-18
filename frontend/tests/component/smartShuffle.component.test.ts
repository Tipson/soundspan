import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PlaylistDetailResponse } from "../../lib/api";
import type { Track } from "../../lib/audio-state-context";
import type { QueueItem } from "../../lib/queue-item";
import { RecommendationQueueAdmission } from "../../lib/audio/recommendationQueueAdmission";
import { recordPlaybackReplacement } from "../../lib/audio-engine/playbackAdvanceOrigin";

GlobalRegistrator.register({
    url: "https://fixture.invalid/playlist/playlist-1",
});
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const track = (id: string): Track => ({
    id,
    title: id,
    artist: { name: "Artist" },
    album: { title: "Album" },
    duration: 180,
});
function snapshot(): PlaylistDetailResponse {
    return {
        id: "playlist-1",
        name: "Mine",
        isOwner: true,
        isPublic: false,
        isHidden: false,
        pendingCount: 0,
        totalItemCount: 6,
        items: ["a", "a", "b", "c", "d", "e"].map((id, i) => ({
            id: `item-${i}`,
            sort: i,
            type: "track",
            track: {
                id,
                title: id,
                duration: 180,
                album: { title: "Album", artist: { name: "Artist" } },
            },
        })),
        pendingTracks: [],
    };
}
let revision = 0,
    auth = 0,
    plays = 0,
    admissionReads = 0;
let loadPool = async () => [track("x"), track("y")];
let loadSnapshot = async () => snapshot();
let coordinator = new RecommendationQueueAdmission(async (refs) => {
    admissionReads++;
    return {
        status: "ready",
        response: {
            version: 1,
            appliesTo: "recommended_future",
            decisions: refs.map((r) => ({ ...r, state: "allowed" })),
        },
    };
}, {});
const state = {
    queue: [] as QueueItem[],
    currentIndex: 0,
    isShuffle: false,
    shuffleIndices: [] as number[],
    getQueueRevision: () => revision,
    setQueue: (queue: QueueItem[]) => {
        state.queue = queue;
        revision++;
    },
    setCurrentIndex: (index: number) => {
        state.currentIndex = index;
        revision++;
    },
    setShuffleIndices: (order: number[]) => {
        state.shuffleIndices = order;
        revision++;
    },
    recommendationFeedback: {
        captureAdmission: () => coordinator.capture(),
        isPreparationCurrent: (
            capture: ReturnType<typeof coordinator.capture>,
        ) => auth === 0 && coordinator.isCurrent(capture),
        readmitCandidates: (
            refs: Parameters<typeof coordinator.readmit>[0],
            signal?: AbortSignal,
        ) => coordinator.readmit(refs, signal),
    },
};
const notices: Array<{ action?: { onClick: () => void } }> = [];
mock.module("@/lib/audio-state-context", {
    namedExports: { useAudioState: () => state },
});
mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: (tracks: Track[]) => {
                plays++;
                state.setQueue(tracks);
                state.setCurrentIndex(0);
                recordPlaybackReplacement();
            },
        }),
    },
});
mock.module("@/lib/listen-together-session", {
    namedExports: { isListenTogetherActiveOrPending: () => false },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getSessionGeneration: () => auth,
            getPlaylist: async () => loadSnapshot(),
            getRadioTracks: async () => ({ tracks: await loadPool() }),
        },
    },
});
mock.module("sonner", {
    namedExports: {
        toast: {
            info: (
                _text: string,
                options?: { action?: { onClick: () => void } },
            ) => notices.push(options ?? {}),
            error: () => {},
            success: () => {},
        },
    },
});

async function scenario(
    work: (
        get: () => ReturnType<
            typeof import("../../features/playlist/hooks/useSmartShuffle").useSmartShuffle
        >,
        render: () => Promise<void>,
    ) => Promise<void>,
    strict = false,
) {
    const { useSmartShuffle } =
        await import("../../features/playlist/hooks/useSmartShuffle");
    const { createRoot } = await import("react-dom/client");
    revision = 0;
    auth = 0;
    plays = 0;
    admissionReads = 0;
    notices.length = 0;
    state.queue = [];
    state.currentIndex = 0;
    coordinator = new RecommendationQueueAdmission(async (refs) => {
        admissionReads++;
        return {
            status: "ready",
            response: {
                version: 1,
                appliesTo: "recommended_future",
                decisions: refs.map((r) => ({ ...r, state: "allowed" })),
            },
        };
    }, {});
    loadPool = async () => [track("x"), track("y")];
    loadSnapshot = async () => snapshot();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let value!: ReturnType<typeof useSmartShuffle>;
    const cached = snapshot();
    function Probe() {
        value = useSmartShuffle("playlist-1", cached);
        return null;
    }
    const render = async () => {
        await React.act(async () =>
            root.render(
                strict
                    ? React.createElement(
                          React.StrictMode,
                          null,
                          React.createElement(Probe),
                      )
                    : React.createElement(Probe),
            ),
        );
    };
    await render();
    try {
        await work(() => value, render);
    } finally {
        await React.act(async () => root.unmount());
        host.remove();
    }
}
async function settle() {
    await tick();
    await tick();
}

test("StrictMode owner opt-in starts a finite full snapshot with own duplicate positions", async () => {
    await scenario(async (get) => {
        await React.act(async () => {
            get().onToggle();
            await settle();
        });
        assert.equal(plays, 1);
        assert.equal(admissionReads, 1);
        assert.deepEqual(
            state.queue
                .filter((t) => (t as Track).smartShuffle?.kind === "own")
                .map((t) => (t as Track).playlistItemId),
            ["item-0", "item-1", "item-2", "item-3", "item-4", "item-5"],
        );
    }, true);
});
for (const kind of ["owner", "edit-undo", "cancel"] as const) {
    test(`held pool cannot attach after ${kind}`, async () => {
        await scenario(async (get) => {
            let finish!: (rows: Track[]) => void;
            loadPool = () => new Promise((resolve) => (finish = resolve));
            await React.act(async () => {
                get().onToggle();
                await settle();
            });
            assert.equal(typeof finish, "function");
            if (kind === "owner") auth++;
            else if (kind === "cancel")
                await React.act(async () => get().onToggle());
            else {
                const old = state.queue;
                state.setQueue([track("edited")]);
                state.setQueue(old);
            }
            await React.act(async () => {
                finish([track("x")]);
                await settle();
            });
            assert.equal(plays, 0);
            assert.deepEqual(state.queue, []);
        });
    });
}
test("pending preference write is awaited by the existing admission coordinator", async () => {
    await scenario(async (get) => {
        const pending = coordinator.beginPreferenceMutation();
        await React.act(async () => {
            get().onToggle();
            await settle();
        });
        assert.equal(admissionReads, 0);
        assert.equal(plays, 0);
        await React.act(async () => {
            coordinator.settlePreferenceMutation(pending);
            await settle();
        });
        assert.equal(admissionReads, 1);
        assert.equal(plays, 1);
    });
});

test("a cancelled old pool cannot clear the next request or attach its discoveries", async () => {
    await scenario(async (get) => {
        const finishes: Array<(rows: Track[]) => void> = [];
        loadPool = () => new Promise((resolve) => finishes.push(resolve));
        await React.act(async () => {
            get().onToggle();
            await settle();
        });
        await React.act(async () => get().onToggle());
        await React.act(async () => {
            get().onToggle();
            await settle();
        });
        assert.equal(finishes.length, 2);
        await React.act(async () => {
            finishes[0]([track("old")]);
            await settle();
        });
        assert.equal(plays, 0);
        assert.equal(get().busy, true);
        await React.act(async () => {
            finishes[1]([track("new")]);
            await settle();
        });
        assert.equal(plays, 1);
        assert.equal(get().busy, false);
        assert.equal(
            state.queue.some((row) => row.id === "old"),
            false,
        );
        assert.equal(
            state.queue.some((row) => row.id === "new"),
            true,
        );
    });
});
test("disable preserves current/history; Undo works only before another queue revision", async () => {
    await scenario(async (get, render) => {
        await React.act(async () => {
            get().onToggle();
            await settle();
        });
        const original = state.queue;
        state.setCurrentIndex(3);
        await render();
        await React.act(async () => get().onToggle());
        assert.equal(state.queue.length, 7);
        assert.deepEqual(
            state.queue.slice(0, 4).map((t) => t.id),
            original.slice(0, 4).map((t) => t.id),
        );
        assert.equal(plays, 1);
        await React.act(async () => notices.at(-1)?.action?.onClick());
        assert.equal(state.queue, original);
        await render();
        await React.act(async () => get().onToggle());
        const disabled = state.queue;
        const undo = notices.at(-1)?.action?.onClick;
        assert.ok(undo);
        state.setQueue([...disabled, track("manual")]);
        await React.act(async () => undo());
        assert.equal(state.queue.length, 8);
        assert.equal(state.queue.at(-1)?.id, "manual");
        assert.equal(plays, 1);
    });
});

test("own100 explains the existing checkpoint limit without pool reads or queue changes", async () => {
    await scenario(async (get) => {
        const source = snapshot();
        source.totalItemCount = 100;
        source.items = Array.from({ length: 100 }, (_, index) => ({
            ...source.items[0],
            id: `item-${index}`,
            sort: index,
        }));
        loadSnapshot = async () => source;
        let pools = 0;
        loadPool = async () => {
            pools++;
            return [];
        };
        const original = state.queue;
        await React.act(async () => {
            get().onToggle();
            await settle();
        });
        assert.equal(plays, 0);
        assert.equal(pools, 0);
        assert.equal(admissionReads, 0);
        assert.equal(state.queue, original);
        assert.equal(get().active, false);
        assert.match(get().notice ?? "", /99/);
    });
});

test("retired owner cannot disable the previous queue while old UI is still mounted", async () => {
    await scenario(async (get) => {
        await React.act(async () => {
            get().onToggle();
            await settle();
        });
        const before = state.queue;
        auth++;
        await React.act(async () => get().onToggle());
        assert.equal(state.queue, before);
        assert.equal(plays, 1);
    });
});
