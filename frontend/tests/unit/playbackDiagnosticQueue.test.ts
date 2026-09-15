import assert from "node:assert/strict";
import test from "node:test";
import {
    createPlaybackDiagnosticQueue,
    sanitizePlaybackDiagnosticFields,
} from "../../lib/audio-engine/playbackDiagnosticQueue";

function harness() {
    let owner: string | null = "user-a";
    let now = 100_000;
    let online = false;
    const data = new Map<string, string>();
    const storage = {
        get length() {
            return data.size;
        },
        key: (index: number) => [...data.keys()][index] ?? null,
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => {
            data.set(key, value);
        },
        removeItem: (key: string) => {
            data.delete(key);
        },
    };
    const sent: unknown[] = [];
    let reject = false;
    const queue = createPlaybackDiagnosticQueue({
        storage,
        ownerId: () => owner,
        online: () => online,
        now: () => now,
        send: async (event) => {
            sent.push(event);
            if (reject) throw new Error("offline");
        },
    });
    return {
        queue,
        data,
        storage,
        sent,
        setOwner: (value: string | null) => {
            owner = value;
        },
        setOnline: (value: boolean) => {
            online = value;
        },
        setNow: (value: number) => {
            now = value;
        },
        setReject: (value: boolean) => {
            reject = value;
        },
    };
}

test("diagnostics exclude credentials, URLs, raw errors and non-finite values", () => {
    const clean = sanitizePlaybackDiagnosticFields({
        trackId: "yt:track-1",
        currentTimeSec: 83,
        bufferedAheadSec: 0,
        online: false,
        reason: "heartbeat_unexpected_stop",
        token: "secret",
        url: "https://media/?token=secret",
        error: new Error("secret"),
        sessionId: "https://secret",
        durationSec: Infinity,
        enginePlaying: true,
    });
    assert.deepEqual(clean, {
        currentTimeSec: 83,
        bufferedAheadSec: 0,
        online: false,
        reason: "heartbeat_unexpected_stop",
        enginePlaying: true,
    });
});

test("offline events survive reload and retain observation time and stable identity", async () => {
    const h = harness();
    try {
        h.queue.enqueue("player.unexpected_stop", {
            currentTimeSec: 83,
            token: "secret",
        });
        await h.queue.flush();
        assert.equal(h.sent.length, 0);
        assert.equal(
            JSON.stringify([...h.data.values()]).includes("secret"),
            false,
        );
        h.queue.dispose();
        const reloaded = createPlaybackDiagnosticQueue({
            storage: h.storage,
            ownerId: () => "user-a",
            online: () => true,
            now: () => 120_000,
            send: async (event) => {
                h.sent.push(event);
            },
        });
        await reloaded.flush();
        const event = h.sent[0] as {
            diagnostic: { ownerId: string; observedAtMs: number; id: string };
            fields: Record<string, unknown>;
        };
        assert.equal(event.diagnostic.ownerId, "user-a");
        assert.equal(event.diagnostic.observedAtMs, 100_000);
        assert.ok(event.diagnostic.id);
        assert.equal(event.fields.currentTimeSec, 83);
        await reloaded.flush();
        assert.equal(h.sent.length, 1);
        reloaded.dispose();
    } finally {
        h.queue.dispose();
    }
});

test("failed delivery is retained, and concurrent flushes send a single request", async () => {
    const h = harness();
    try {
        h.queue.enqueue("player.unexpected_pause", {});
        h.setReject(true);
        h.setOnline(true);
        await Promise.all([h.queue.flush(), h.queue.flush()]);
        assert.equal(h.sent.length, 1);
        h.setReject(false);
        await h.queue.wake();
        assert.equal(h.sent.length, 2);
        assert.deepEqual(h.sent[0], h.sent[1]);
    } finally {
        h.queue.dispose();
    }
});

test("logout, account changes, queue capacity and expiry bound retained diagnostics", async () => {
    const h = harness();
    try {
        for (let i = 0; i < 120; i++)
            h.queue.enqueue("player.unexpected_stop", { currentTimeSec: i });
        h.setOnline(true);
        await h.queue.flush();
        assert.equal(h.sent.length, 96);
        h.setOnline(false);
        h.queue.enqueue("player.unexpected_stop", {});
        h.setOwner("user-b");
        h.setOnline(true);
        await h.queue.flush();
        assert.equal(h.sent.length, 96);
        h.setOnline(false);
        h.queue.enqueue("player.unexpected_stop", {});
        h.setOwner(null);
        await h.queue.flush();
        h.setOwner("user-b");
        h.setOnline(true);
        await h.queue.flush();
        assert.equal(h.sent.length, 96);
        h.setOnline(false);
        h.queue.enqueue("player.unexpected_stop", {});
        h.setNow(100_000 + 24 * 60 * 60 * 1000 + 1);
        h.setOnline(true);
        await h.queue.flush();
        assert.equal(h.sent.length, 96);
    } finally {
        h.queue.dispose();
    }
});

test("durable incidents exclude track identities and retain an anonymous playback run", async () => {
    const h = harness();
    try {
        h.queue.enqueue("player.engine_pause", {
            trackId: "yt:private-song",
            sessionId: "recommendation-session",
            playbackRunId: "playback-run-1",
            sourceKind: "device_file",
            nativePaused: true,
            engineEnded: false,
            readyState: 4,
            networkState: 1,
        });
        const persisted = [...h.data.values()].join("");
        assert.ok(persisted.includes("playback-run-1"));
        assert.ok(persisted.includes("device_file"));
        assert.equal(persisted.includes("private-song"), false);
        assert.equal(persisted.includes("recommendation-session"), false);
        h.setNow(12 * 60 * 60 * 1000);
        h.setOnline(true);
        await h.queue.flush();
        assert.equal(h.sent.length, 1);
    } finally {
        h.queue.dispose();
    }
});

test("large snapshots are bounded by bytes as well as event count", async () => {
    const h = harness();
    try {
        for (let i = 0; i < 150; i++) {
            h.queue.enqueue("player.playback_error", {
                reason: "r".repeat(128),
                errorCode: "e".repeat(128),
                errorCategory: "c".repeat(128),
                playbackRunId: "p".repeat(128),
                stage: "s".repeat(128),
                currentTimeSec: i,
            });
        }
        const bytes = [...h.data.values()].reduce(
            (sum, value) => sum + Buffer.byteLength(value),
            0,
        );
        assert.ok(bytes <= 65_536, `stored ${bytes} bytes`);
        h.setOnline(true);
        await h.queue.flush();
        assert.ok(h.sent.length <= 96);
        assert.equal(
            (h.sent.at(-1) as { fields: { currentTimeSec: number } }).fields
                .currentTimeSec,
            149,
        );
    } finally {
        h.queue.dispose();
    }
});

test("a failed burst has a finite automatic retry budget and wakes on explicit connectivity recovery", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
    let online = true;
    const sent: unknown[] = [];
    const queue = createPlaybackDiagnosticQueue({
        storage: null,
        ownerId: () => "user-a",
        online: () => online,
        send: async (event) => {
            sent.push(event);
            throw Error("unreachable");
        },
    });
    try {
        queue.enqueue("player.unexpected_pause", {});
        await queue.flush();
        for (let i = 0; i < 20; i++) {
            t.mock.timers.tick(60_000);
            await Promise.resolve();
            await Promise.resolve();
            await queue.flush();
        }
        assert.ok(sent.length <= 6, `${sent.length} retries were sent`);
        const beforeWake = sent.length;
        online = false;
        queue.enqueue("player.visibility_change", { visibility: "hidden" });
        t.mock.timers.tick(120_000);
        await queue.flush();
        assert.equal(sent.length, beforeWake);
        online = true;
        await queue.wake();
        assert.equal(sent.length, beforeWake + 1);
    } finally {
        queue.dispose();
    }
});

test("a late send completion cannot resurrect a cleared account outbox", async () => {
    const data = new Map<string, string>();
    let resolveSend!: () => void;
    let owner: string | null = "user-a";
    const queue = createPlaybackDiagnosticQueue({
        storage: {
            get length() {
                return data.size;
            },
            key: (index) => [...data.keys()][index] ?? null,
            getItem: (key) => data.get(key) ?? null,
            setItem: (key, value) => {
                data.set(key, value);
            },
            removeItem: (key) => {
                data.delete(key);
            },
        },
        ownerId: () => owner,
        online: () => true,
        send: () =>
            new Promise<void>((resolve) => {
                resolveSend = resolve;
            }),
    });
    try {
        queue.enqueue("player.unexpected_stop", {});
        const pending = queue.flush();
        await Promise.resolve();
        await Promise.resolve();
        queue.clear();
        owner = "user-b";
        resolveSend();
        await pending;
        assert.equal(data.size, 0);
    } finally {
        queue.dispose();
    }
});

test("restricted storage and corrupted persisted data cannot break diagnostics", async () => {
    const sent: unknown[] = [];
    const queue = createPlaybackDiagnosticQueue({
        storage: {
            get length(): number {
                throw Error("denied");
            },
            key: () => null,
            getItem: () => "broken",
            setItem: () => {
                throw Error("quota");
            },
            removeItem: () => {
                throw Error("denied");
            },
        },
        ownerId: () => "user-a",
        online: () => true,
        send: async (e) => {
            sent.push(e);
        },
    });
    try {
        queue.enqueue("player.unexpected_stop", {});
        await queue.flush();
        assert.equal(sent.length, 1);
    } finally {
        queue.dispose();
    }
});

test("successful retry clears durable backoff before the next incident", async () => {
    const h = harness();
    try {
        h.queue.enqueue("player.unexpected_stop", {});
        h.queue.enqueue("player.unexpected_pause", {});
        h.setOnline(true);
        h.setReject(true);
        await h.queue.flush();
        h.setReject(false);
        h.setNow(102_001);
        await h.queue.flush();
        assert.equal(h.sent.length, 3);
        assert.equal(h.data.size, 0);
    } finally {
        h.queue.dispose();
    }
});

test("another tab's appended incident survives an in-flight acknowledgement", async () => {
    const h = harness();
    let finish!: () => void;
    const sending = createPlaybackDiagnosticQueue({
        storage: h.storage,
        ownerId: () => "user-a",
        online: () => true,
        now: () => 100_000,
        send: () =>
            new Promise<void>((resolve) => {
                finish = resolve;
            }),
    });
    try {
        sending.enqueue("player.unexpected_stop", {});
        const pending = sending.flush();
        await Promise.resolve();
        await Promise.resolve();
        h.queue.enqueue("player.engine_pause", {});
        sending.dispose();
        finish();
        await pending;
        h.setOnline(true);
        await h.queue.flush();
        assert.equal(h.sent.length, 2);
    } finally {
        sending.dispose();
        h.queue.dispose();
    }
});

test("diagnostics preserve explicit unknown native state and executing code version", () => {
    assert.deepEqual(
        sanitizePlaybackDiagnosticFields({
            diagnosticsVersion: 2,
            nativePaused: null,
            localSource: true,
        }),
        {
            diagnosticsVersion: 2,
            nativePaused: null,
            localSource: true,
        },
    );
});

test("interleaved writes from two tabs do not overwrite either unsent incident", async () => {
    const data = new Map<string, string>();
    let interleave: (() => void) | null = null;
    const storage = {
        get length() {
            return data.size;
        },
        key: (index: number) => [...data.keys()][index] ?? null,
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => {
            const callback = interleave;
            interleave = null;
            callback?.();
            data.set(key, value);
        },
        removeItem: (key: string) => {
            data.delete(key);
        },
    };
    let online = false;
    const sent: string[] = [];
    const options = {
        storage,
        ownerId: () => "user-a",
        online: () => online,
        send: async (event: { event: string }) => {
            sent.push(event.event);
        },
    };
    const first = createPlaybackDiagnosticQueue(options);
    const second = createPlaybackDiagnosticQueue(options);
    try {
        interleave = () => second.enqueue("player.engine_pause", {});
        first.enqueue("player.unexpected_stop", {});
        await first.flush();
        await second.flush();
        online = true;
        await first.flush();
        assert.deepEqual(sent.sort(), [
            "player.engine_pause",
            "player.unexpected_stop",
        ]);
    } finally {
        first.dispose();
        second.dispose();
    }
});

test("an enqueue arriving while an empty flush settles still starts delivery", async () => {
    const sent: string[] = [];
    const queue = createPlaybackDiagnosticQueue({
        storage: null,
        ownerId: () => "user-a",
        online: () => true,
        send: async (item) => {
            sent.push(item.event);
        },
    });
    try {
        const empty = queue.flush();
        await Promise.resolve();
        queue.enqueue("player.playback_error", {});
        await empty;
        for (let i = 0; i < 15; i++) await Promise.resolve();
        assert.deepEqual(sent, ["player.playback_error"]);
    } finally {
        queue.dispose();
    }
});

test("legacy per-tab records migrate once with stable ids and without track history", async () => {
    const h = harness();
    const old = new Map([
        [
            "soundspan.playback-diagnostics.v1",
            JSON.stringify([
                {
                    event: "player.unexpected_stop",
                    fields: {
                        trackId: "private-song",
                        sessionId: "private-session",
                        currentTimeSec: 4,
                    },
                    diagnostic: {
                        id: "old-a",
                        ownerId: "user-a",
                        observedAtMs: 100_000,
                    },
                },
                {
                    event: "player.unexpected_stop",
                    fields: {},
                    diagnostic: {
                        id: "old-b",
                        ownerId: "user-b",
                        observedAtMs: 100_000,
                    },
                },
            ]),
        ],
    ]);
    const migrated = createPlaybackDiagnosticQueue({
        storage: h.storage,
        legacyStorage: {
            getItem: (key) => old.get(key) ?? null,
            removeItem: (key) => {
                old.delete(key);
            },
        },
        ownerId: () => "user-a",
        online: () => true,
        now: () => 110_000,
        send: async (item) => {
            h.sent.push(item);
        },
    });
    try {
        assert.equal(old.size, 0);
        assert.equal([...h.data.values()].join("").includes("private"), false);
        await migrated.flush();
        assert.equal(h.sent.length, 1);
        assert.equal(
            (h.sent[0] as { diagnostic: { id: string } }).diagnostic.id,
            "old-a",
        );
    } finally {
        migrated.dispose();
        h.queue.dispose();
    }
});

test("429 survives reload and keeps backoff whereas invalid payloads are terminal", async () => {
    const h = harness();
    const first = createPlaybackDiagnosticQueue({
        storage: h.storage,
        ownerId: () => "user-a",
        online: () => true,
        now: () => 100_000,
        send: async () => {
            throw { status: 429 };
        },
    });
    first.enqueue("player.unexpected_stop", {});
    await first.flush();
    first.dispose();
    let attempts = 0;
    let now = 100_100;
    const restored = createPlaybackDiagnosticQueue({
        storage: h.storage,
        ownerId: () => "user-a",
        online: () => true,
        now: () => now,
        send: async () => {
            attempts++;
            throw { status: 413 };
        },
    });
    try {
        await restored.flush();
        assert.equal(attempts, 0);
        now = 102_000;
        await restored.flush();
        assert.equal(attempts, 1);
        assert.equal(h.data.size, 0);
        await restored.wake();
        assert.equal(attempts, 1);
    } finally {
        restored.dispose();
        h.queue.dispose();
    }
});

test("a live late acknowledgement deletes only its id and preserves another tab's new event", async () => {
    const h = harness();
    let acknowledge!: () => void;
    let online = true;
    const sent: string[] = [];
    const first = createPlaybackDiagnosticQueue({
        storage: h.storage,
        ownerId: () => "user-a",
        online: () => online,
        now: () => 100_000,
        send: async (item) => {
            sent.push(item.event);
            await new Promise<void>((resolve) => {
                acknowledge = resolve;
            });
        },
    });
    try {
        first.enqueue("player.unexpected_stop", {});
        const active = first.flush();
        await Promise.resolve();
        await Promise.resolve();
        h.queue.enqueue("player.engine_pause", {});
        online = false;
        acknowledge();
        await active;
        h.setOnline(true);
        await h.queue.flush();
        assert.deepEqual(sent, ["player.unexpected_stop"]);
        assert.equal(h.sent.length, 1);
        assert.equal(
            (h.sent[0] as { event: string }).event,
            "player.engine_pause",
        );
    } finally {
        first.dispose();
        h.queue.dispose();
    }
});

test("wake after dispose neither sends nor overwrites a live owner's backlog", async () => {
    const h = harness();
    h.queue.enqueue("player.engine_pause", {});
    await h.queue.flush();
    h.queue.dispose();
    const saved = [...h.data.entries()];
    h.setOwner("user-b");
    h.setOnline(true);
    await h.queue.wake();
    assert.deepEqual([...h.data.entries()], saved);
    assert.equal(h.sent.length, 0);
});

test("an acknowledged event is not resent in a loop if the browser refuses its removal", async () => {
    const h = harness();
    h.queue.enqueue("player.engine_pause", {});
    await h.queue.flush();
    h.queue.dispose();
    let sent = 0;
    const queue = createPlaybackDiagnosticQueue({
        storage: {
            ...h.storage,
            get length() {
                return h.storage.length;
            },
            removeItem: () => {
                throw Error("storage access revoked");
            },
        },
        ownerId: () => "user-a",
        online: () => true,
        now: () => 100_000,
        send: async () => {
            sent++;
        },
    });
    try {
        await queue.flush();
        await queue.wake();
        assert.equal(sent, 1);
    } finally {
        queue.dispose();
    }
});
