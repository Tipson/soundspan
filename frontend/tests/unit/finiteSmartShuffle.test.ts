import assert from "node:assert/strict";
import test from "node:test";
import type { Track } from "../../lib/audio-state-context";
import {
    buildSmartShuffleQueue,
    disableSmartShuffle,
    readSmartShuffleLineage,
    disableSmartShufflePlayback,
} from "../../lib/audio/finiteSmartShuffle";
import { normalizeQueueItems } from "../../lib/queue-item";

const track = (id: string, itemId?: string): Track => ({
    id,
    title: "Same title",
    duration: 180,
    artist: { name: "Artist" },
    album: { title: "Album" },
    ...(itemId ? { playlistItemId: itemId } : {}),
});
const options = { playlistId: "playlist-1", sessionId: "session-1", seed: 123 };
const own = [
    track("a", "item-1"),
    track("a", "item-2"),
    track("b", "item-3"),
    track("c", "item-4"),
    track("d", "item-5"),
    track("e", "item-6"),
];

test("seeded finite insertion preserves ordered own duplicate occurrences and never loops the pool", () => {
    const before = JSON.stringify(own);
    const queue = buildSmartShuffleQueue(
        own,
        [track("x"), track("y"), track("a")],
        options,
    );
    assert.deepEqual(
        queue
            .filter((t) => t.smartShuffle?.kind === "own")
            .map((t) => t.playlistItemId),
        own.map((t) => t.playlistItemId),
    );
    assert.equal(queue.length, 8);
    assert.deepEqual(
        queue.map((t) => t.smartShuffle?.kind),
        ["own", "own", "own", "injected", "own", "own", "own", "injected"],
    );
    assert.equal(
        new Set(queue.map((t) => t.smartShuffle?.occurrenceId)).size,
        8,
    );
    assert.deepEqual(
        buildSmartShuffleQueue(
            own,
            [track("x"), track("y"), track("a")],
            options,
        ),
        queue,
    );
    assert.equal(JSON.stringify(own), before);
    const exhausted = buildSmartShuffleQueue(
        [
            ...own,
            track("f", "item-7"),
            track("g", "item-8"),
            track("h", "item-9"),
        ],
        [track("x")],
        options,
    );
    assert.equal(
        exhausted.filter((t) => t.smartShuffle?.kind === "injected").length,
        1,
    );
    assert.ok(
        queue
            .filter((t) => t.smartShuffle?.kind === "own")
            .every((t) => !t.recommendationSessionId),
    );
    assert.ok(
        queue
            .filter((t) => t.smartShuffle?.kind === "injected")
            .every((t) => t.recommendationQueueMode === "finite"),
    );
});

test("one own item gets one end discovery; outage keeps every original position", () => {
    const short = buildSmartShuffleQueue([own[0]], [track("x")], options);
    assert.deepEqual(
        short.map((t) => t.id),
        ["a", "x"],
    );
    assert.deepEqual(
        buildSmartShuffleQueue(own, [], options).map((t) => t.playlistItemId),
        own.map((t) => t.playlistItemId),
    );
});

test("disable removes only matching future injections, preserving current/history, manual rows and cursor", () => {
    const queue = buildSmartShuffleQueue(
        own,
        [track("x"), track("y")],
        options,
    );
    const edited = [...queue, track("manual")];
    const disabled = disableSmartShuffle(edited, 3, "session-1");
    assert.deepEqual(
        disabled.slice(0, 4).map((t) => t.id),
        edited.slice(0, 4).map((t) => t.id),
    );
    assert.equal(disabled.at(-1)?.id, "manual");
    assert.equal(disabled.length, edited.length - 1);
    assert.ok(
        disabled
            .filter((t) => t.smartShuffle)
            .every((t) => t.smartShuffle?.enabled === false),
    );
    assert.equal(disabled[0].smartShuffle?.cursor, 2);
    assert.equal(disableSmartShuffle(edited, 3, "different"), edited);
});

test("closed lineage survives cold JSON restore and rejects future/malformed mode", () => {
    const queue = buildSmartShuffleQueue(own, [track("x")], {
        ...options,
        ...{ extra: "not persisted" },
    });
    assert.ok(queue[0].smartShuffle);
    assert.equal(Object.hasOwn(queue[0].smartShuffle, "extra"), false);
    const stored = JSON.parse(JSON.stringify(queue));
    assert.deepEqual(
        normalizeQueueItems(stored).map((t) => (t as Track).smartShuffle),
        queue.map((t) => t.smartShuffle),
    );
    assert.deepEqual(
        readSmartShuffleLineage(stored[0].smartShuffle),
        queue[0].smartShuffle,
    );
    assert.equal(
        readSmartShuffleLineage({ ...stored[0].smartShuffle, v: 2 }),
        undefined,
    );
    assert.equal(
        readSmartShuffleLineage({ ...stored[0].smartShuffle, seed: -1 }),
        undefined,
    );
    assert.equal(
        readSmartShuffleLineage({ ...stored[0].smartShuffle, cursor: 51 }),
        undefined,
    );
});

test("disable uses existing shuffled history/remap and never removes the current occurrence", () => {
    const queue = buildSmartShuffleQueue(
        own,
        [track("x"), track("y")],
        options,
    );
    const next = disableSmartShufflePlayback(
        {
            queue,
            currentIndex: 4,
            isShuffle: true,
            shuffleIndices: [4, 0, 3, 1, 2, 5, 6, 7],
        },
        "session-1",
    );
    assert.equal(next.currentIndex, 3);
    assert.equal(next.queue[next.currentIndex].id, queue[4].id);
    assert.equal(next.queue.length, 6);
    assert.deepEqual(next.shuffleIndices, [3, 0, 1, 2, 4, 5]);
    assert.ok(
        next.queue.every((t) => (t as Track).smartShuffle?.kind === "own"),
    );
});

test("checkpoint capacity never truncates own positions or overfills the durable 100-row queue", () => {
    const hundred = Array.from({ length: 100 }, (_, i) =>
        track("same", `item-${i}`),
    );
    assert.throws(() =>
        buildSmartShuffleQueue(hundred, [track("discovery")], options),
    );
    const near = buildSmartShuffleQueue(
        hundred.slice(0, 99),
        [track("x"), track("y")],
        options,
    );
    assert.equal(near.length, 100);
    assert.equal(
        near.filter((t) => t.smartShuffle?.kind === "injected").length,
        1,
    );
    const restored = normalizeQueueItems(
        JSON.parse(JSON.stringify(near)),
    ) as Track[];
    assert.equal(restored.length, 100);
    assert.deepEqual(
        restored
            .filter((t) => t.smartShuffle?.kind === "own")
            .map((t) => t.playlistItemId),
        hundred.slice(0, 99).map((t) => t.playlistItemId),
    );
    assert.deepEqual(
        restored.map((t) => t.smartShuffle),
        near.map((t) => t.smartShuffle),
    );
    assert.throws(() =>
        buildSmartShuffleQueue(
            [...hundred, track("same", "item-100")],
            [],
            options,
        ),
    );
    const many = Array.from({ length: 5000 }, (_, i) =>
        track("same", `item-${i}`),
    );
    const original = JSON.stringify(many);
    assert.throws(() =>
        buildSmartShuffleQueue(many, [track("discovery")], options),
    );
    assert.equal(JSON.stringify(many), original);
});
