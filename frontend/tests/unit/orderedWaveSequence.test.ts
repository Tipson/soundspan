import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
    readOrderedWavePage,
    OrderedWaveQueueCheckpoints,
} from "../../lib/audio/orderedWaveSequence";
import { toProviderPlaybackTrack } from "../../lib/audio/providerRadioContinuation";
import { selectWaveTracks } from "../../features/home/selectWaveTracks";

const fixture = JSON.parse(
    readFileSync(
        new URL("../../../fixtures/ordered-wave-v1.json", import.meta.url),
        "utf8",
    ),
);
const owner = { authGeneration: 1, sessionId: "tab-a", intent: "for-you:any" };
const page = () =>
    readOrderedWavePage({
        orderedWave: structuredClone(fixture.cases[0].orderedWave),
    })!;

for (const mode of ["for-you", "new", "familiar"] as const)
    test(`server order bypasses client shelf merging in ${mode}`, () => {
        const raw = fixture.cases[0].orderedWave;
        assert.deepEqual(
            selectWaveTracks(
                { listenAgain: [], quickPicks: [], discovery: [] },
                mode,
                raw,
            ).map((track) => track.youtubeVideoId),
            fixture.cases[0].expectedIds,
        );
    });
test("retired Tidal sequence items fail attachment rather than becoming local files", () => {
    const candidate = {
        ...page().items[0].track,
        id: "tidal:123",
        source: "tidal" as const,
        streamSource: "tidal" as const,
        youtubeVideoId: undefined,
        provider: { youtubeVideoId: null, tidalTrackId: 123 },
    };
    assert.throws(
        () => toProviderPlaybackTrack(candidate),
        /Tidal.*unavailable/,
    );
});

for (const entry of fixture.cases)
    test(`shared ordered fixture: ${entry.name}`, () => {
        const result = readOrderedWavePage({ orderedWave: entry.orderedWave })!;
        assert.deepEqual(
            result.items.map((row) => row.track.youtubeVideoId),
            entry.expectedIds,
        );
        assert.deepEqual(
            result.items.map((row) => row.position),
            entry.expectedIds.map(
                (_id: string, index: number) => result.startPosition + index,
            ),
        );
    });
test("only an absent envelope permits the legacy shelf path", () => {
    assert.equal(readOrderedWavePage({}), undefined);
    for (const value of [null, {}, { version: 2 }, "ordered"])
        assert.throws(() => readOrderedWavePage({ orderedWave: value }));
});
for (const kind of [
    "duplicate",
    "position",
    "tail-reorder",
    "partial-tail",
    "cursor",
    "version",
    "source",
    "alias",
    "overflow",
    "oversize",
])
    test(`rejects malformed ${kind} rather than changing order`, () => {
        const raw = structuredClone(fixture.cases[0].orderedWave);
        if (kind === "duplicate") raw.items[1].track = raw.items[0].track;
        if (kind === "position") raw.items[1].position = 50;
        if (kind === "tail-reorder") raw.tail.reverse();
        if (kind === "partial-tail") raw.tail.pop();
        if (kind === "cursor") raw.nextCursor = "x".repeat(1025);
        if (kind === "version") raw.version = 2;
        if (kind === "source") raw.items[0].track.source = "library";
        if (kind === "alias") raw.items[0].track.youtubeVideoId = "ZZZZZZZZZZZ";
        if (kind === "overflow") raw.startPosition = 2_147_483_647;
        if (kind === "oversize")
            raw.items = Array.from({ length: 26 }, () => raw.items[0]);
        assert.throws(() => readOrderedWavePage({ orderedWave: raw }));
    });
test("captures only the exact committed queue and runtime owner", () => {
    const checkpoints = new OrderedWaveQueueCheckpoints();
    const data = page();
    const queue = data.items.map((row) => toProviderPlaybackTrack(row.track));
    assert.equal(checkpoints.commit(queue, data, owner), true);
    assert.deepEqual(checkpoints.capture(queue, owner), {
        sequenceId: data.sequenceId,
        nextPosition: 6,
        nextCursor: data.nextCursor,
        tail: data.tail,
    });
    assert.equal(checkpoints.capture([...queue], owner), undefined);
    assert.equal(
        checkpoints.capture(queue, { ...owner, authGeneration: 2 }),
        undefined,
    );
    assert.equal(
        checkpoints.capture(queue, { ...owner, intent: "new:any" }),
        undefined,
    );
});
test("removing/reordering the middle invalidates even when the final two tracks agree", () => {
    const checkpoints = new OrderedWaveQueueCheckpoints();
    const data = page();
    const queue = data.items.map((row) => toProviderPlaybackTrack(row.track));
    assert.equal(checkpoints.commit(queue, data, owner), true);
    [queue[0], queue[1]] = [queue[1], queue[0]];
    assert.equal(checkpoints.capture(queue, owner), undefined);
    assert.equal(checkpoints.capture(queue, owner), undefined);
});
test("shuffle invalidates the old checkpoint even after shuffle is turned off", () => {
    const checkpoints = new OrderedWaveQueueCheckpoints();
    const data = page();
    const queue = data.items.map((row) => toProviderPlaybackTrack(row.track));
    checkpoints.commit(queue, data, owner);
    assert.equal(checkpoints.capture(queue, owner, true), undefined);
    assert.equal(checkpoints.capture(queue, owner, false), undefined);
});
test("a filtered or reordered server page cannot grant a continuation checkpoint", () => {
    const checkpoints = new OrderedWaveQueueCheckpoints();
    const data = page();
    const queue = data.items.map((row) => toProviderPlaybackTrack(row.track));
    assert.equal(checkpoints.commit(queue.slice(1), data, owner), false);
    assert.equal(checkpoints.commit([...queue].reverse(), data, owner), false);
    assert.equal(checkpoints.commit([queue[0], ...queue], data, owner), true);
    checkpoints.invalidate(queue);
    assert.equal(checkpoints.capture(queue, owner), undefined);
});
