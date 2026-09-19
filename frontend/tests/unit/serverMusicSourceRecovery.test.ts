import assert from "node:assert/strict";
import { test } from "node:test";
import {
    createServerMusicSourceRecovery,
    type ServerSourceRecoveryInput,
} from "../../lib/audio/serverMusicSourceRecovery";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

const input: ServerSourceRecoveryInput = {
    key: "occurrence:1",
    recording: {
        title: "Recording",
        artists: ["Artist"],
        duration: 240,
        contentVersion: "unknown",
    },
    positionSec: 73.5,
};
const path = `/api/music-sources/leases/${"a".repeat(48)}/stream`;

test("recovery resolves once and hands the same occurrence and trusted position to a new transport", async () => {
    const applied: unknown[] = [];
    let requests = 0;
    const recovery = createServerMusicSourceRecovery({
        isCurrent: () => true,
        resolve: async (recording) => {
            requests++;
            assert.deepEqual(recording, input.recording);
            return path;
        },
        apply: async (url, captured) => {
            applied.push([url, captured]);
        },
    });
    assert.equal(await recovery.recover(input), "recovered");
    assert.deepEqual(applied, [[path, input]]);
    assert.equal(await recovery.recover(input), "exhausted");
    assert.equal(requests, 1);
});

test("duplicate errors do not start another request or deadlock the load-error listener", async () => {
    const request = deferred<string | null>();
    const recovery = createServerMusicSourceRecovery({
        isCurrent: () => true,
        resolve: () => request.promise,
        apply: async () => {},
    });
    const original = recovery.recover(input);
    assert.equal(await recovery.recover(input), "in_progress");
    request.resolve(path);
    assert.equal(await original, "recovered");
});

test("a later selection discards an old successful resolution without replacing its audio", async () => {
    const request = deferred<string | null>();
    let current = true,
        applied = 0;
    const recovery = createServerMusicSourceRecovery({
        isCurrent: () => current,
        resolve: () => request.promise,
        apply: async () => {
            applied++;
        },
    });
    const pending = recovery.recover(input);
    current = false;
    request.resolve(path);
    assert.equal(await pending, "stale");
    assert.equal(applied, 0);
});

test("pause or unmount aborts a pending request immediately even if the transport ignores abort", async () => {
    const request = deferred<string | null>();
    let observed: AbortSignal | undefined,
        applied = 0;
    const recovery = createServerMusicSourceRecovery({
        isCurrent: () => true,
        resolve: (_recording, signal) => {
            observed = signal;
            return request.promise;
        },
        apply: async () => {
            applied++;
        },
    });
    const pending = recovery.recover(input);
    recovery.cancel();
    assert.equal(await pending, "stale");
    assert.equal(observed?.aborted, true);
    request.resolve(path);
    await Promise.resolve();
    assert.equal(applied, 0);
});

test("a failed or ambiguous match never starts audio and consumes the bounded attempt", async () => {
    let applied = 0;
    const recovery = createServerMusicSourceRecovery({
        isCurrent: () => true,
        resolve: async () => null,
        apply: async () => {
            applied++;
        },
    });
    assert.equal(await recovery.recover(input), "no_candidate");
    assert.equal(await recovery.recover(input), "exhausted");
    assert.equal(applied, 0);
});

test("a stalled replacement reaches the total deadline and aborts its listeners", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const started = deferred<void>();
    let signal: AbortSignal | undefined;
    const recovery = createServerMusicSourceRecovery({
        timeoutMs: 100,
        isCurrent: () => true,
        resolve: async () => path,
        apply: (_url, _input, currentSignal) => {
            signal = currentSignal;
            started.resolve();
            return new Promise(() => {});
        },
    });
    const pending = recovery.recover(input);
    await started.promise;
    t.mock.timers.tick(100);
    assert.equal(await pending, "failed");
    assert.equal(signal?.aborted, true);
});

test("the next load gets its own budget and cancellation of the prior load cannot clear it", async () => {
    const request = deferred<string | null>();
    let calls = 0;
    const recovery = createServerMusicSourceRecovery({
        isCurrent: () => true,
        resolve: async () => (++calls === 1 ? request.promise : path),
        apply: async () => {},
    });
    const old = recovery.recover(input);
    const newer = recovery.recover({ ...input, key: "occurrence:2" });
    assert.equal(await old, "stale");
    assert.equal(await newer, "recovered");
    request.resolve(path);
    assert.equal(
        await recovery.recover({ ...input, key: "occurrence:2" }),
        "exhausted",
    );
});
