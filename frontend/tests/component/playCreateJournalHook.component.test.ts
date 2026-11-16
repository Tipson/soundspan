import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import React, { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
    advanceAuthRuntimeGeneration,
    getAuthRuntimeLease,
} from "../../lib/auth-runtime-generation";
import { installPlayCreateJournalBridge } from "../../lib/playCreateJournalBridge";
import type { Track } from "../../lib/audio-state-context";
import type { PlayEngagementInput, PlayLogInput } from "../../lib/api/plays";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const state = {
    confirmed: false,
    localOccurrence: 0,
    collaborative: false,
    legacy: [] as PlayLogInput[],
    patches: [] as PlayEngagementInput[],
};
mock.module("@/lib/listen-together-session", {
    namedExports: {
        isListenTogetherActiveOrPending: () => state.collaborative,
    },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            async logPlay(input: PlayLogInput) {
                state.legacy.push(input);
                return { id: "legacy-" + state.legacy.length };
            },
            async updatePlayEngagement(
                _id: string,
                input: PlayEngagementInput,
            ) {
                state.patches.push(input);
                return { success: true };
            },
        },
    },
});
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let hook: ReturnType<
    typeof import("../../components/player/hooks/usePlayEngagementTracking").usePlayEngagementTracking
>;
let dispose: (() => void) | null = null;
beforeEach(() => {
    advanceAuthRuntimeGeneration();
    state.confirmed = false;
    state.localOccurrence = 0;
    state.collaborative = false;
    state.legacy.length = 0;
    state.patches.length = 0;
});
afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    dispose?.();
    dispose = null;
});
after(() => GlobalRegistrator.unregister());
const track = {
    id: "yt:video",
    youtubeVideoId: "video",
    title: "Song",
    artist: { name: "Artist" },
    album: { title: "Album" },
    duration: 100,
    streamSource: "youtube",
} as Track;
async function render(
    selected: Track | null = track,
    index = 0,
    playbackType: "track" | "podcast" | "audiobook" | null = "track",
) {
    const { usePlayEngagementTracking } =
        await import("../../components/player/hooks/usePlayEngagementTracking");
    function Harness() {
        const options = {
            currentTrack: selected,
            currentIndex: index,
            localTrackPlaybackOccurrence: state.localOccurrence,
            playbackType,
            isPlaying: true,
            isBuffering: false,
            vibeMode: true,
            waveMode: "for-you" as const,
            isCurrentEngineOccurrence: () => state.confirmed,
        };
        const value = usePlayEngagementTracking(options);
        useLayoutEffect(() => {
            hook = value;
        });
        return null;
    }
    // Keep component identity stable across metadata/index rerenders.
    currentRender = Harness;
    if (!root) {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
    }
    await act(async () => root!.render(React.createElement(StableHarness)));
}
let currentRender: () => null;
function StableHarness() {
    return currentRender();
}
function install() {
    const begins: PlayLogInput[] = [],
        notes: { input: PlayEngagementInput; final: boolean }[] = [],
        events: string[] = [];
    let resolve!: (value: { id: string }) => void;
    const created = new Promise<{ id: string }>((done) => {
        resolve = done;
    });
    const runtime = {
        begin(input: PlayLogInput) {
            begins.push(input);
            return {
                key: "run-" + begins.length,
                mode: "keyed" as const,
                persisted: Promise.resolve(true),
                created,
                async noteEngagement(
                    input: PlayEngagementInput,
                    final: boolean,
                ) {
                    notes.push({ input, final });
                    events.push("final");
                    return true;
                },
            };
        },
        async close() {
            events.push("close");
        },
        suspendForHistoryClear() {
            return async () => undefined;
        },
    };
    dispose = installPlayCreateJournalBridge({
        runtime,
        api: {},
        authLease: getAuthRuntimeLease(),
    });
    return { begins, notes, events, resolve };
}
test("UI play intent and unconfirmed play event do not create listening history", async () => {
    await render();
    await act(async () => hook.startCurrentPlay());
    assert.equal(state.legacy.length, 0);
    state.confirmed = true;
    await act(async () => hook.startCurrentPlay());
    assert.equal(state.legacy.length, 1);
});
test("confirmed native progress can start a run when the play event preceded load confirmation", async () => {
    await render();
    state.confirmed = true;
    await act(async () => {
        hook.noteProgress(5);
        hook.finishFailed();
    });
    assert.equal(state.legacy.length, 1);
    assert.deepEqual(state.patches, [
        { listenedSeconds: 5, completionRatio: 0.05, outcome: "failed" },
    ]);
});
test("durable final is captured before ACK with no keyless creation or PATCH", async () => {
    const f = install();
    await render();
    state.confirmed = true;
    await act(async () => {
        hook.startCurrentPlay();
        hook.noteProgress(4);
        hook.finishFailed();
    });
    assert.equal(f.begins.length, 1);
    assert.deepEqual(f.notes, [
        {
            input: {
                listenedSeconds: 4,
                completionRatio: 0.04,
                outcome: "failed",
            },
            final: true,
        },
    ]);
    assert.equal(state.legacy.length, 0);
    assert.equal(state.patches.length, 0);
    f.resolve({ id: "known" });
    await act(async () => Promise.resolve());
    assert.equal(f.notes.length, 1);
});
test("metadata refresh preserves occurrence, while adjacent duplicate index creates a distinct run", async () => {
    const f = install();
    state.confirmed = true;
    await render();
    await act(async () => {
        hook.startCurrentPlay();
        hook.noteProgress(5);
    });
    await render({
        ...track,
        title: "Updated",
        duration: 120,
        album: { ...track.album, coverArt: "updated" },
    });
    await act(async () => hook.startCurrentPlay());
    assert.equal(f.begins.length, 1);
    state.localOccurrence++;
    await render({ ...track }, 1);
    await act(async () => hook.startCurrentPlay());
    assert.equal(f.begins.length, 2);
    assert.equal(f.notes[0].input.listenedSeconds, 5);
});
test("provider cleanup finalizes the tracker before closing its journal and later hook cleanup is idempotent", async () => {
    const f = install();
    await render();
    state.confirmed = true;
    await act(async () => {
        hook.startCurrentPlay();
        hook.noteProgress(6);
    });
    dispose!();
    dispose = null;
    assert.deepEqual(f.events, ["final", "close"]);
    await act(async () => root!.unmount());
    root = null;
    assert.equal(f.notes.length, 1);
});
test("a hook bound to a disposed provider cannot adopt the replacement runtime", async () => {
    const old = install();
    await render();
    state.confirmed = true;
    await act(async () => hook.startCurrentPlay());
    const replacement = install();
    await render({ ...track, id: "yt:next", youtubeVideoId: "next" });
    await act(async () => hook.startCurrentPlay());
    assert.equal(old.begins.length, 1);
    assert.equal(replacement.begins.length, 0);
    assert.equal(state.legacy.length, 0);
});
for (const playbackType of ["podcast", "audiobook", null] as const) {
    test(`switching playback type to ${playbackType} finalizes the remote run even with a retained track`, async () => {
        const f = install();
        await render();
        state.confirmed = true;
        await act(async () => {
            hook.startCurrentPlay();
            hook.noteProgress(5);
        });
        state.confirmed = false;
        await render(track, 0, playbackType);
        assert.deepEqual(f.notes, [
            {
                input: {
                    listenedSeconds: 5,
                    completionRatio: 0.05,
                    outcome: "skipped",
                },
                final: true,
            },
        ]);
        await act(async () => hook.noteProgress(10));
        assert.equal(f.begins.length, 1);
    });
}
test("clearing the current track finalizes once without inventing another run", async () => {
    const f = install();
    await render();
    state.confirmed = true;
    await act(async () => {
        hook.startCurrentPlay();
        hook.noteProgress(5);
    });
    state.confirmed = false;
    await render(null);
    assert.equal(f.notes.length, 1);
    assert.equal(f.notes[0].final, true);
    await render(null);
    assert.equal(f.notes.length, 1);
    assert.equal(f.begins.length, 1);
});
test("solo prefix removal remaps the cursor without a fake skip or second Play", async () => {
    const f = install();
    state.confirmed = true;
    await render(track, 1);
    await act(async () => {
        hook.startCurrentPlay();
        hook.noteProgress(5);
    });
    await render(track, 0);
    await act(async () => hook.noteProgress(6));
    assert.equal(f.begins.length, 1);
    assert.equal(f.notes.length, 0);
    state.localOccurrence++;
    await render({ ...track }, 1);
    await act(async () => hook.startCurrentPlay());
    assert.equal(f.begins.length, 2);
    assert.equal(f.notes.length, 1);
    assert.equal(f.notes[0].input.listenedSeconds, 6);
});
test("an explicit same-object same-index commit creates a new run while pause and metadata do not", async () => {
    const f = install();
    state.confirmed = true;
    await render();
    await act(async () => hook.startCurrentPlay());
    state.confirmed = false;
    await render();
    state.confirmed = true;
    await act(async () => hook.startCurrentPlay());
    assert.equal(f.begins.length, 1);
    state.localOccurrence++;
    await render();
    await act(async () => hook.startCurrentPlay());
    assert.equal(f.begins.length, 2);
});
test("joining and leaving a group on the same recording preserves the selected solo run", async () => {
    const f = install();
    const row = { ...track, playlistItemId: "one" };
    state.confirmed = true;
    await render(row, 3);
    await act(async () => {
        hook.startCurrentPlay();
        hook.noteProgress(5);
    });
    state.collaborative = true;
    await render(track, 0);
    await act(async () => hook.noteProgress(6));
    state.collaborative = false;
    await render(row, 9);
    await act(async () => hook.noteProgress(7));
    assert.equal(f.begins.length, 1);
    assert.deepEqual(f.notes, []);
    assert.equal(state.legacy.length, 0);
});
test("new group runs remain legacy and leaving never upgrades the selected run", async () => {
    const f = install();
    state.collaborative = true;
    state.confirmed = true;
    await render();
    await act(async () => {
        hook.startCurrentPlay();
        hook.noteProgress(5);
    });
    assert.equal(f.begins.length, 0);
    assert.equal(state.legacy.length, 1);
    state.collaborative = false;
    await render(track, 4);
    await act(async () => hook.noteProgress(6));
    assert.equal(f.begins.length, 0);
    assert.equal(state.legacy.length, 1);
    await act(async () => {
        hook.finishCompleted();
        hook.startCurrentPlay();
    });
    assert.equal(f.begins.length, 1);
    assert.equal(state.legacy.length, 1);
});

for (const retirement of ["auth", "runtime"] as const) {
    test(`a stale group callback cannot start legacy history after ${retirement} retirement`, async () => {
        install();
        state.collaborative = true;
        state.confirmed = true;
        await render();
        const old = hook;
        if (retirement === "auth") advanceAuthRuntimeGeneration();
        const replacement = install();
        await act(async () => {
            old.startCurrentPlay();
            old.noteProgress(4);
        });
        assert.equal(state.legacy.length, 0);
        assert.equal(replacement.begins.length, 0);
    });
}
