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
        trackId: "yt:track-1",
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
        await h.queue.flush();
        assert.equal(h.sent.length, 2);
        assert.deepEqual(h.sent[0], h.sent[1]);
    } finally {
        h.queue.dispose();
    }
});

test("logout, account changes, queue capacity and expiry bound retained diagnostics", async () => {
    const h = harness();
    try {
        for (let i = 0; i < 45; i++)
            h.queue.enqueue("player.unexpected_stop", { currentTimeSec: i });
        h.setOnline(true);
        await h.queue.flush();
        assert.equal(h.sent.length, 32);
        h.setOnline(false);
        h.queue.enqueue("player.unexpected_stop", {});
        h.setOwner("user-b");
        h.setOnline(true);
        await h.queue.flush();
        assert.equal(h.sent.length, 32);
        h.setOnline(false);
        h.queue.enqueue("player.unexpected_stop", {});
        h.setOwner(null);
        await h.queue.flush();
        h.setOwner("user-b");
        h.setOnline(true);
        await h.queue.flush();
        assert.equal(h.sent.length, 32);
        h.setOnline(false);
        h.queue.enqueue("player.unexpected_stop", {});
        h.setNow(4_000_000);
        h.setOnline(true);
        await h.queue.flush();
        assert.equal(h.sent.length, 32);
    } finally {
        h.queue.dispose();
    }
});

test("restricted storage and corrupted persisted data cannot break diagnostics", async () => {
    const sent: unknown[] = [];
    const queue = createPlaybackDiagnosticQueue({
        storage: {
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
