import assert from "node:assert/strict";
import test from "node:test";
import { createPlayEngagementTracker } from "../../components/player/hooks/playEngagementSession";
import type { PlayEngagementInput, PlayLogInput } from "../../lib/api/plays";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
const play: PlayLogInput = {
    youtubeVideoId: "recording",
    title: "Song",
    artist: "Artist",
    album: "Album",
    duration: 100,
};
const tick = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};
function fixture() {
    const created = deferred<{ id: string }>();
    const notes: { input: PlayEngagementInput; final: boolean }[] = [];
    const errors: string[] = [];
    let legacyCreates = 0,
        legacyPatches = 0,
        begins = 0;
    const ticket = {
        key: "frozen-run",
        mode: "keyed" as const,
        persisted: Promise.resolve(true),
        created: created.promise,
        async noteEngagement(input: PlayEngagementInput, final: boolean) {
            notes.push({ input: { ...input }, final });
            return true;
        },
    };
    const dependencies = {
        beginPlay(_input: PlayLogInput): typeof ticket | null {
            begins++;
            return ticket;
        },
        async logPlay() {
            legacyCreates++;
            return { id: "legacy" };
        },
        async updatePlayEngagement() {
            legacyPatches++;
            return { success: true as const };
        },
        onError(stage: string) {
            errors.push(stage);
        },
    };
    return {
        created,
        ticket,
        dependencies,
        notes,
        errors,
        counts: () => ({ legacyCreates, legacyPatches, begins }),
        tracker: createPlayEngagementTracker(dependencies),
    };
}

test("durable final is captured before a delayed create acknowledgement with no legacy write", async () => {
    const f = fixture();
    f.tracker.start({ key: "occurrence-1", play, durationSeconds: 100 });
    f.tracker.noteProgress(5);
    f.tracker.noteProgress(10);
    f.tracker.finish("completed");
    f.tracker.finish("completed");
    await tick();
    assert.deepEqual(f.notes, [
        {
            input: {
                listenedSeconds: 10,
                completionRatio: 1,
                outcome: "completed",
            },
            final: true,
        },
    ]);
    assert.deepEqual(f.counts(), {
        legacyCreates: 0,
        legacyPatches: 0,
        begins: 1,
    });
    f.created.resolve({ id: "known" });
    await tick();
    assert.equal(f.notes.length, 1);
    assert.equal(f.counts().legacyPatches, 0);
});

test("unknown keyed create never falls back or loses a later failed final", async () => {
    const f = fixture();
    f.tracker.start({ key: "one", play, durationSeconds: 100 });
    f.created.reject(new Error("ACK unknown"));
    await tick();
    f.tracker.noteProgress(4);
    f.tracker.finish("failed");
    await tick();
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
    assert.deepEqual(f.counts(), {
        legacyCreates: 0,
        legacyPatches: 0,
        begins: 1,
    });
    assert.deepEqual(f.errors, ["create"]);
});

test("legacy selection remains frozen when a durable ticket becomes available later", async () => {
    const f = fixture();
    let ready = false;
    f.dependencies.beginPlay = () => (ready ? f.ticket : null);
    const tracker = createPlayEngagementTracker(f.dependencies);
    tracker.start({ key: "one", play, durationSeconds: 100 });
    ready = true;
    tracker.start({ key: "one", play, durationSeconds: 100 });
    tracker.finish("transition");
    await tick();
    assert.equal(f.counts().legacyCreates, 1);
    assert.equal(f.counts().legacyPatches, 1);
    assert.equal(f.notes.length, 0);
});

test("same-track repeat starts a new delivery after the previous occurrence finishes", async () => {
    const f = fixture();
    f.tracker.start({ key: "one", play, durationSeconds: 100 });
    f.tracker.finish("completed");
    f.tracker.start({ key: "one", play, durationSeconds: 100 });
    f.tracker.noteProgress(5);
    f.tracker.finish("transition");
    await tick();
    assert.equal(f.counts().begins, 2);
    assert.deepEqual(
        f.notes.map((n) => n.input.outcome),
        ["completed", "skipped"],
    );
});

test("meaningful durable checkpoints use thirty listened-second cadence and never invent an early skip", async () => {
    const f = fixture();
    f.tracker.start({ key: "one", play, durationSeconds: 100 });
    for (let pos = 5; pos <= 25; pos += 5) f.tracker.noteProgress(pos);
    assert.equal(f.notes.length, 0);
    for (let pos = 30; pos <= 75; pos += 5) f.tracker.noteProgress(pos);
    f.tracker.finish("transition");
    await tick();
    assert.deepEqual(f.notes, [
        {
            input: {
                listenedSeconds: 30,
                completionRatio: 0.3,
                outcome: "meaningful",
            },
            final: false,
        },
        {
            input: {
                listenedSeconds: 60,
                completionRatio: 0.6,
                outcome: "meaningful",
            },
            final: false,
        },
        {
            input: {
                listenedSeconds: 75,
                completionRatio: 0.75,
                outcome: "meaningful",
            },
            final: true,
        },
    ]);
});

test("seeking and rewinding do not fabricate listened seconds or duplicate checkpoints", async () => {
    const f = fixture();
    f.tracker.start({ key: "one", play, durationSeconds: 100 });
    f.tracker.noteProgress(80);
    f.tracker.noteProgress(5);
    f.tracker.noteProgress(5);
    f.tracker.noteProgress(NaN);
    f.tracker.noteProgress(Infinity);
    assert.equal(f.notes.length, 0);
    for (let pos = 10; pos <= 35; pos += 5) f.tracker.noteProgress(pos);
    f.tracker.finish("failed");
    await tick();
    assert.deepEqual(
        f.notes.map((n) => [n.input.listenedSeconds, n.input.outcome, n.final]),
        [
            [30, "meaningful", false],
            [30, "failed", true],
        ],
    );
    assert.equal(f.notes[1].input.completionRatio, 0.8);
});

test("a rejected durable checkpoint is reported without using legacy delivery", async () => {
    const f = fixture();
    f.ticket.noteEngagement = async () => false;
    f.tracker.start({ key: "one", play, durationSeconds: 100 });
    f.tracker.finish("transition");
    await tick();
    assert.deepEqual(f.errors, ["finalize"]);
    assert.deepEqual(f.counts(), {
        legacyCreates: 0,
        legacyPatches: 0,
        begins: 1,
    });
});

test("a synchronous durable selection failure cannot trigger a legacy POST", async () => {
    const f = fixture();
    f.dependencies.beginPlay = () => {
        throw new Error("selection unavailable");
    };
    const tracker = createPlayEngagementTracker(f.dependencies);
    assert.doesNotThrow(() =>
        tracker.start({ key: "one", play, durationSeconds: 100 }),
    );
    tracker.finish("transition");
    await tick();
    assert.deepEqual(f.errors, ["create"]);
    assert.equal(f.counts().legacyCreates, 0);
    assert.equal(f.counts().legacyPatches, 0);
});
