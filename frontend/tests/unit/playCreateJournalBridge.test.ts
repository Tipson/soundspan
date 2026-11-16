import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
    advanceAuthRuntimeGeneration,
    getAuthRuntimeLease,
} from "../../lib/auth-runtime-generation";
import {
    createPlayJournalDeliveryScope,
    installPlayCreateJournalBridge,
    suspendPlayCreateJournalHistory,
} from "../../lib/playCreateJournalBridge";
import type { PlayLogInput } from "../../lib/api/plays";

const play: PlayLogInput = {
    youtubeVideoId: "x",
    title: "Song",
    artist: "Artist",
    album: "Album",
    duration: 100,
};
const disposers: (() => void)[] = [];
beforeEach(() => advanceAuthRuntimeGeneration());
afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
});
function fixture() {
    const events: string[] = [];
    const api = {};
    let closed = false;
    const runtime = {
        begin(_input: PlayLogInput) {
            if (closed) throw new Error("closed");
            events.push("begin");
            return {
                key: "key",
                mode: "keyed" as const,
                created: Promise.resolve({ id: "id" }),
                persisted: Promise.resolve(true),
                async noteEngagement() {
                    return true;
                },
            };
        },
        async close() {
            closed = true;
            events.push("close");
        },
        suspendForHistoryClear() {
            events.push("suspend");
            return async (success: boolean) => {
                events.push(`finish:${success}`);
            };
        },
    };
    const authLease = getAuthRuntimeLease();
    const install = () => {
        const dispose = installPlayCreateJournalBridge({
            runtime,
            api,
            authLease,
        });
        disposers.push(dispose);
        return dispose;
    };
    return { events, api, runtime, authLease, install };
}
test("a scope created before installation can select legacy once then bind its first installed runtime", () => {
    const f = fixture();
    const scope = createPlayJournalDeliveryScope(f.authLease);
    assert.equal(scope.begin(play), null);
    f.install();
    assert.equal(scope.begin(play)?.mode, "keyed");
    assert.deepEqual(f.events, ["begin"]);
});

test("a side-effect-free current assertion binds its first live runtime and rejects later replacement", () => {
    const first = fixture();
    const scope = createPlayJournalDeliveryScope(first.authLease);
    assert.doesNotThrow(() => scope.assertCurrent());
    first.install();
    assert.doesNotThrow(() => scope.assertCurrent());
    assert.deepEqual(first.events, []);
    const second = fixture();
    second.install();
    assert.throws(() => scope.assertCurrent());
    assert.deepEqual(second.events, []);
});
test("old scopes cannot adopt replacement runtime or silently select legacy after disposal", () => {
    const a = fixture();
    const dispose = a.install();
    const scope = createPlayJournalDeliveryScope(a.authLease);
    assert.ok(scope.begin(play));
    dispose();
    assert.throws(() => scope.begin(play));
    const b = fixture();
    b.install();
    assert.throws(() => scope.begin(play));
    assert.deepEqual(b.events, []);
});
test("finalizers run synchronously before close and stale disposal preserves the new installation", () => {
    const a = fixture();
    const dispose = a.install();
    const scope = createPlayJournalDeliveryScope(a.authLease);
    scope.registerFinalizer(() => a.events.push("final"));
    const b = fixture();
    b.install();
    dispose();
    assert.deepEqual(a.events, ["final", "close"]);
    assert.ok(createPlayJournalDeliveryScope(b.authLease).begin(play));
    assert.deepEqual(b.events, ["begin"]);
});
test("unregistered finalizers are not retained and one failed finalizer cannot skip another", () => {
    const f = fixture();
    const dispose = f.install();
    const scope = createPlayJournalDeliveryScope(f.authLease);
    const remove = scope.registerFinalizer(() => f.events.push("removed"));
    remove();
    scope.registerFinalizer(() => {
        throw new Error("private-data");
    });
    scope.registerFinalizer(() => f.events.push("final"));
    assert.doesNotThrow(dispose);
    assert.deepEqual(f.events, ["final", "close"]);
});
test("revoked auth prevents old accounting even if no provider is currently installed", () => {
    const f = fixture();
    const scope = createPlayJournalDeliveryScope(f.authLease);
    advanceAuthRuntimeGeneration();
    assert.throws(() => scope.begin(play));
    f.install();
    assert.deepEqual(f.events, ["close"]);
});
test("history barrier captures only its matching API instance and finishes once", () => {
    const f = fixture();
    f.install();
    suspendPlayCreateJournalHistory({})(true);
    assert.deepEqual(f.events, []);
    const finish = suspendPlayCreateJournalHistory(f.api);
    assert.deepEqual(f.events, ["suspend"]);
    finish(false);
    finish(true);
    assert.deepEqual(f.events, ["suspend", "finish:false"]);
});
test("late history finish remains bound to the old runtime after replacement", () => {
    const a = fixture();
    a.install();
    const finish = suspendPlayCreateJournalHistory(a.api);
    const b = fixture();
    b.install();
    finish(true);
    assert.deepEqual(a.events, ["suspend", "close", "finish:true"]);
    assert.deepEqual(b.events, []);
});
