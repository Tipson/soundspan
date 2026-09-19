import assert from "node:assert/strict";
import test from "node:test";
import {
    ContinuousAudioBuffer,
    type ContinuousAudioSource,
} from "../../lib/audio-engine/continuousAudioBuffer";

// Deterministic parser port: one fixture byte represents one second of audio.
// Real container decoding is covered separately in browser integration tests.
class SequenceBuffer extends EventTarget {
    updating = false;
    mode: SourceBuffer["mode"] = "sequence";
    timestampOffset = 0;
    ranges: Array<[number, number]> = [];
    types: string[] = [];
    appendSizes: number[] = [];
    failNextAppend = false;
    get buffered(): TimeRanges {
        return {
            length: this.ranges.length,
            start: (i) => this.ranges[i][0],
            end: (i) => this.ranges[i][1],
        };
    }
    appendBuffer(bytes: ArrayBuffer): void {
        assert.equal(this.updating, false, "mutations must be serialized");
        this.updating = true;
        this.appendSizes.push(bytes.byteLength);
        queueMicrotask(() => {
            this.updating = false;
            if (this.failNextAppend) {
                this.failNextAppend = false;
                this.dispatchEvent(new Event("error"));
                return;
            }
            const start = this.timestampOffset;
            const end = start + bytes.byteLength;
            const tail = this.ranges.at(-1);
            if (tail && tail[1] === start) tail[1] = end;
            else this.ranges.push([start, end]);
            this.timestampOffset = end;
            this.dispatchEvent(new Event("updateend"));
        });
    }
    remove(start: number, end: number): void {
        assert.equal(this.updating, false);
        this.updating = true;
        queueMicrotask(() => {
            this.ranges = this.ranges.flatMap(([a, b]) => {
                if (b <= start || a >= end) return [[a, b]];
                const kept: Array<[number, number]> = [];
                if (a < start) kept.push([a, start]);
                if (b > end) kept.push([end, b]);
                return kept;
            });
            this.updating = false;
            this.dispatchEvent(new Event("updateend"));
        });
    }
    abort(): void {}
    changeType(mime: string): void {
        this.types.push(mime);
    }
}

const source = (id: string, seconds: number): ContinuousAudioSource => ({
    id,
    url: `blob:${id}`,
    blob: new Blob([new Uint8Array(seconds)]),
    mime: "audio/mpeg",
    durationSec: seconds,
});

function harness(first = source("a", 100)) {
    const buffer = new SequenceBuffer();
    let position = 0;
    const boundaries: string[] = [];
    const ready: string[] = [];
    const transport = new ContinuousAudioBuffer({
        buffer,
        current: first,
        readPosition: () => position,
        chunkBytes: 10,
        aheadSec: 30,
        behindSec: 15,
        onBoundary: (id) => boundaries.push(id),
        onNextReady: (id) => ready.push(id),
    });
    return {
        buffer,
        transport,
        boundaries,
        ready,
        setPosition: (p: number) => {
            position = p;
        },
    };
}

test("continuous buffering bounds reads and evicts played ranges", async () => {
    const h = harness();
    await h.transport.pump();
    assert.deepEqual(h.buffer.ranges, [[0, 30]]);
    assert.ok(h.buffer.appendSizes.every((size) => size <= 10));
    h.setPosition(25);
    await h.transport.pump();
    assert.deepEqual(h.buffer.ranges, [[10, 60]]);
    h.transport.dispose();
});

test("a natural boundary advances staged ownership once without resetting the timeline", async () => {
    const h = harness(source("a", 20));
    h.transport.stageNext(source("b", 40));
    await h.transport.pump();
    assert.deepEqual(h.ready, ["b"]);
    h.setPosition(20.1);
    h.transport.checkBoundary();
    h.transport.checkBoundary();
    assert.deepEqual(h.boundaries, ["a"]);
    assert.equal(h.transport.current.id, "b");
    assert.equal(h.transport.current.startSec, 20);
    // React's preload cleanup can precede adoption of the new queue item.
    h.transport.cancelNext("b");
    h.transport.stageNext(source("c", 40));
    await h.transport.pump();
    assert.equal(h.transport.current.id, "b");
    assert.equal(h.buffer.ranges.at(-1)?.[1], 60);
    h.transport.dispose();
});

test("replacing an appended next source removes its audio before appending the replacement", async () => {
    const h = harness(source("a", 20));
    h.transport.stageNext(source("stale", 40));
    await h.transport.pump();
    h.transport.cancelNext("stale");
    h.transport.stageNext(source("replacement", 7));
    await h.transport.pump();
    assert.deepEqual(h.buffer.ranges, [[0, 27]]);
    h.setPosition(20);
    h.transport.checkBoundary();
    assert.equal(h.transport.current.id, "replacement");
    h.transport.dispose();
});

test("seek refills evicted audio from local bytes and keeps staged sources bounded", async () => {
    const h = harness();
    await h.transport.pump();
    h.setPosition(70);
    await h.transport.pump();
    await h.transport.seek(5);
    assert.equal(h.transport.current.startSec, 0);
    assert.ok(h.buffer.ranges.some(([a, b]) => a <= 5 && b > 5));
    assert.ok(h.buffer.ranges.at(-1)![1] <= 40);
    h.transport.dispose();
});

test("empty and invalid segments reject instead of reporting preload readiness", async () => {
    const empty = harness(source("empty", 0));
    await assert.rejects(empty.transport.pump(), /empty/i);
    empty.transport.dispose();
    const broken = harness();
    broken.buffer.failNextAppend = true;
    await assert.rejects(broken.transport.pump(), /append|buffer/i);
    broken.transport.dispose();
});

test("disposing during a source read prevents late audio from being appended", async () => {
    let finish!: (bytes: ArrayBuffer) => void;
    const delayed = source("delayed", 20);
    delayed.blob = {
        size: 20,
        slice: () => ({
            arrayBuffer: () =>
                new Promise<ArrayBuffer>((resolve) => {
                    finish = resolve;
                }),
        }),
    } as unknown as Blob;
    const h = harness(delayed);
    const pending = h.transport.pump();
    h.transport.dispose();
    finish(new ArrayBuffer(10));
    await pending;
    assert.equal(h.buffer.appendSizes.length, 0);
});

test("native pumping during a seek cannot mutate the SourceBuffer concurrently", async () => {
    const h = harness();
    await h.transport.pump();
    h.setPosition(70);
    const seek = h.transport.seek(5);
    const refill = h.transport.pump();
    await Promise.all([seek, refill]);
    assert.ok(h.buffer.ranges.some(([a, b]) => a <= 5 && b > 5));
    h.transport.dispose();
});

test("the latest of simultaneous seeks owns the refill position", async () => {
    const h = harness();
    await h.transport.pump();
    await Promise.all([
        h.transport.seek(5),
        h.transport.seek(60),
        h.transport.pump(),
    ]);
    assert.ok(h.buffer.ranges.some(([a, b]) => a <= 60 && b > 60));
    assert.equal(h.buffer.ranges.at(-1)?.[1], 90);
    h.transport.dispose();
});

test("exhaustion tracks all supplied bytes and clears when another recording is staged", async () => {
    const h = harness(source("a", 8));
    h.transport.stageNext(source("b", 9));
    assert.equal(h.transport.exhausted, false);
    await h.transport.pump();
    assert.equal(h.transport.exhausted, true);
    h.setPosition(8.1);
    h.transport.checkBoundary();
    h.transport.stageNext(source("c", 9));
    assert.equal(h.transport.exhausted, false);
    await h.transport.pump();
    assert.equal(h.transport.exhausted, true);
    h.transport.dispose();
});
