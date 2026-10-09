import assert from "node:assert/strict";
import test from "node:test";
import {
    recordExplicitPlaybackPause,
    writePlaybackReplacementIntent,
} from "../../lib/audio-engine/playbackAdvanceOrigin";
import { requestRadioQueue } from "../../lib/radio/radioRequestIntent";
const deferred = () => {
    let resolve!: (tracks: string[]) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string[]>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};
for (const order of ["old-first", "new-first"]) {
    test(`latest radio action wins when ${order} resolves`, async () => {
        const a = deferred(),
            b = deferred();
        let queue = ["existing"];
        const commit = async (pending: ReturnType<typeof deferred>) => {
            const tracks = await requestRadioQueue(() => pending.promise);
            if (tracks) queue = tracks;
        };
        const oldRequest = commit(a),
            newRequest = commit(b);
        if (order === "old-first") {
            a.resolve(["old"]);
            await oldRequest;
            assert.deepEqual(queue, ["existing"]);
            b.resolve(["new"]);
        } else {
            b.resolve(["new"]);
            await newRequest;
            a.resolve(["old"]);
        }
        await Promise.all([oldRequest, newRequest]);
        assert.deepEqual(queue, ["new"]);
    });
}
for (const cancel of [
    recordExplicitPlaybackPause,
    () => writePlaybackReplacementIntent("other"),
]) {
    test(`radio does not replace queue after ${cancel.name || "playback change"}`, async () => {
        const pending = deferred();
        const result = requestRadioQueue(() => pending.promise);
        cancel();
        pending.resolve(["radio"]);
        assert.equal(await result, null);
    });
}
test("failed latest radio preserves the existing queue and does not revive an older request", async () => {
    const a = deferred(),
        b = deferred();
    let queue = ["existing"];
    const oldRequest = requestRadioQueue(() => a.promise);
    const newRequest = requestRadioQueue(() => b.promise);
    b.reject(new Error("unavailable"));
    await assert.rejects(newRequest, /unavailable/);
    a.resolve(["old"]);
    const tracks = await oldRequest;
    if (tracks) queue = tracks;
    assert.deepEqual(queue, ["existing"]);
});
test("stale failures are ignored", async () => {
    const a = deferred();
    const oldRequest = requestRadioQueue(() => a.promise);
    await requestRadioQueue(async () => ["new"]);
    a.reject(new Error("old error"));
    assert.equal(await oldRequest, null);
});
