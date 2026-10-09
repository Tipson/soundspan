import assert from "node:assert/strict";
import test from "node:test";
import { extendArtistPlayback } from "../../features/artist/artistPlaybackContinuation";
import type { Track } from "../../features/artist/types";
const track = (id: string): Track => ({
    id,
    title: id,
    duration: 180,
    artist: { name: "Artist" },
    filePath: `/music/${id}`,
});
const audio = (t: Track) => ({
    id: t.id,
    title: t.title,
    duration: t.duration,
    artist: { name: "Artist" },
    album: { title: "Album" },
});
test("artist continuation keeps clicked display remainder then every unseen library/provider page", async () => {
    const queue = [audio(track("five")), audio(track("six"))];
    async function* pages() {
        yield [track("one"), track("six"), track("seven")];
        yield [track("seven"), track("eight")];
    }
    const result = await extendArtistPlayback({
        initialTracks: ["one", "two", "three", "four", "five", "six"].map(
            track,
        ),
        initialQueue: queue,
        pages: pages(),
        isCurrent: () => true,
        getQueueIds: () => queue.map((t) => t.id),
        formatTrack: audio,
        append: (tracks) => {
            queue.push(...tracks);
        },
    });
    assert.equal(result, "completed");
    assert.deepEqual(
        queue.map((t) => t.id),
        ["five", "six", "seven", "eight"],
    );
});
test("artist continuation cannot append after another collection replaces the queue", async () => {
    let queue = [audio(track("five"))];
    async function* pages() {
        queue = [audio(track("other"))];
        yield [track("six")];
    }
    const result = await extendArtistPlayback({
        initialTracks: [track("five")],
        initialQueue: queue,
        pages: pages(),
        isCurrent: () => true,
        getQueueIds: () => queue.map((t) => t.id),
        formatTrack: audio,
        append: (tracks) => {
            queue.push(...tracks);
        },
    });
    assert.equal(result, "cancelled");
    assert.deepEqual(
        queue.map((t) => t.id),
        ["other"],
    );
});
