import assert from "node:assert/strict";
import { mock, test } from "node:test";
const calls: unknown[][] = [];
let candidates: unknown[] = [];
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getRadioTracks: async (...args: unknown[]) => {
                calls.push(args);
                return { tracks: candidates };
            },
        },
    },
});
async function loadTrackRadio(seed: ReturnType<typeof track>) {
    const m = await import("../../lib/radio/loadTrackRadio");
    return m.loadTrackRadio(seed);
}
const track = (id: string, videoId?: string) => ({
    id,
    title: id,
    duration: 180,
    artist: { name: "Artist", id: "artist" },
    album: { title: "Album" },
    ...(videoId
        ? { streamSource: "youtube" as const, youtubeVideoId: videoId }
        : {}),
});
test("remote track radio requests its provider seed and removes seed aliases and duplicates", async () => {
    candidates = [
        track("other-id", "seed"),
        track("a", "next"),
        track("alias", "next"),
        { id: "broken" },
    ];
    const result = await loadTrackRadio(track("yt:seed", "seed"));
    assert.deepEqual(calls.at(-1), ["youtube", "seed"]);
    assert.deepEqual(
        result.map((t) => t.youtubeVideoId),
        ["next"],
    );
});
test("local track radio uses track similarity rather than requiring an artist id", async () => {
    candidates = [track("seed"), track("next")];
    const result = await loadTrackRadio(track("seed"));
    assert.deepEqual(calls.at(-1), ["vibe", "seed"]);
    assert.deepEqual(
        result.map((t) => t.id),
        ["next"],
    );
});
test("seed-only radio stays empty", async () => {
    candidates = [track("alias", "seed")];
    assert.deepEqual(await loadTrackRadio(track("yt:seed", "seed")), []);
});

test("track radio keeps the original recording on every returned candidate", async () => {
    candidates = [track("first", "next"), track("second", "another")];
    const result = await loadTrackRadio(track("yt:seedVideo01", "seedVideo01"));
    for (const candidate of result) {
        assert.deepEqual(candidate.radioOrigin, {
            kind: "track",
            source: "youtube",
            id: "seedVideo01",
        });
    }
    candidates = [track("local-next")];
    const local = await loadTrackRadio(track("local-seed"));
    assert.deepEqual(local[0].radioOrigin, {
        kind: "track",
        source: "library",
        id: "local-seed",
    });
});

test("playlist radio normalization keeps provider playback identity", async () => {
    const { normalizeRadioTracks } =
        await import("../../lib/radio/loadTrackRadio");
    const result = normalizeRadioTracks([
        track("yt:next", "next"),
        track("alias", "next"),
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].youtubeVideoId, "next");
    assert.equal(result[0].streamSource, "youtube");
});

test("unsupported providers explain radio availability without querying local similarity", async () => {
    const { loadTrackRadio: load } =
        await import("../../lib/radio/loadTrackRadio");
    const before = calls.length;
    await assert.rejects(
        load({
            ...track("audius:abc"),
            streamSource: "audius",
            provider: { source: "audius", providerTrackId: "abc" },
        }),
        /локальных треков и YouTube/,
    );
    assert.equal(calls.length, before);
});
