import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileRadioSnapshotMetadata } from "../../lib/radio/radioSnapshotMetadata";

const originA = { kind: "artist", source: "library", id: "a" } as const;
const originB = { kind: "artist", source: "discovery", name: "B" } as const;
const track = {
    id: "same",
    title: "Local",
    filePath: "original.mp3",
    radioOrigin: originA,
};
const queue = [track, { ...track, id: "bridge" }, track];
const input = () => ({
    localCurrentTrack: track,
    localQueue: queue,
    localCurrentIndex: 2,
    localPlaybackType: "track" as const,
    localLastSaveAtMs: 10,
    localLastServerSyncAtMs: 20,
    serverPlaybackType: "track" as const,
    serverMediaId: "same",
    serverCurrentIndex: 2,
    serverUpdatedAtMs: 30,
    serverQueue: queue.map((row, index) => ({
        ...row,
        title: "Server",
        filePath: "other.mp3",
        radioOrigin: index === 0 ? originA : originB,
    })),
});

test("radio metadata merge preserves local rows and selected duplicate occurrence", () => {
    const result = reconcileRadioSnapshotMetadata(input())!;
    assert.deepEqual(result.currentTrack, { ...track, radioOrigin: originB });
    assert.equal(result.queue[0], queue[0]);
    assert.deepEqual(result.queue[1], { ...queue[1], radioOrigin: originB });
    assert.deepEqual(result.queue[2], { ...queue[2], radioOrigin: originB });
});

test("equal normalized station metadata does not create a replacement", () => {
    assert.equal(
        reconcileRadioSnapshotMetadata({
            ...input(),
            serverQueue: queue.map((row) => ({
                ...row,
                radioOrigin: { ...originA, privateField: "discard" },
            })),
        }),
        null,
    );
});

test("current-track-only reconciliation retains the already matching queue reference", () => {
    const matchingQueue = queue.map((row) => ({
        ...row,
        radioOrigin: originB,
    }));
    const result = reconcileRadioSnapshotMetadata({
        ...input(),
        localQueue: matchingQueue,
        serverQueue: matchingQueue,
    })!;
    assert.equal(result.queue, matchingQueue);
    assert.deepEqual(result.currentTrack.radioOrigin, originB);
});

test("explicit absence clears origin without borrowing another occurrence", () => {
    const result = reconcileRadioSnapshotMetadata({
        ...input(),
        serverQueue: queue.map((row, index) =>
            index === 2 ? { id: row.id } : row,
        ),
    })!;
    assert.equal(result.currentTrack.radioOrigin, undefined);
    assert.equal(result.queue[0], track);
    assert.equal(result.queue[2].radioOrigin, undefined);
    assert.equal(result.currentTrack.title, track.title);
});

for (const [name, fields] of Object.entries({
    "other media": { serverMediaId: "other" },
    "other type": { serverPlaybackType: "podcast" },
    "other occurrence": { serverCurrentIndex: 0 },
    "out of bounds": { serverCurrentIndex: 99 },
    "missing index": { serverCurrentIndex: undefined },
    "fractional index": { serverCurrentIndex: 2.5 },
    "string index": { serverCurrentIndex: "2" },
    "old local save": { localLastSaveAtMs: 30 },
    "old server sync": { localLastServerSyncAtMs: 30 },
    "nonfinite timestamp": { serverUpdatedAtMs: NaN },
    "negative timestamp": { serverUpdatedAtMs: -1 },
    "missing selected track": { localCurrentTrack: null },
    "truncated queue": { serverQueue: queue.slice(0, 2) },
    "other order": { serverQueue: [queue[1], queue[0], queue[2]] },
    "invalid row": { serverQueue: [...queue, null] },
    "sparse queue": { serverQueue: [track, , track] },
    "unknown item type": {
        serverQueue: queue.map((row) => ({ ...row, itemType: "unknown" })),
    },
    "episode queue": {
        localQueue: queue.map((row) => ({ ...row, itemType: "episode" })),
    },
    "malformed origin": {
        serverQueue: queue.map((row) => ({
            ...row,
            radioOrigin: { kind: "track", source: "tidal", id: "bad" },
        })),
    },
})) {
    test(`radio metadata rejects ${name}`, () => {
        assert.equal(
            reconcileRadioSnapshotMetadata({
                ...input(),
                ...fields,
            } as Parameters<typeof reconcileRadioSnapshotMetadata>[0]),
            null,
        );
    });
}
