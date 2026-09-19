import assert from "node:assert/strict";
import test from "node:test";
import { mergeServiceCatalogResults } from "../../features/search/serviceCatalogMerge";
import type { DiscoverResult } from "../../features/search/types";
const youtube: DiscoverResult = {
    type: "track",
    id: "youtube",
    name: "Song",
    artist: "Artist",
    duration: 180,
    streamSource: "youtube",
    youtubeVideoId: "abcdefghijk",
};
const vk = {
    provider: "vk" as const,
    id: "1_2",
    title: "Song",
    artists: ["Artist"],
    duration: 180,
    contentVersion: "explicit" as const,
    preview: false,
};
test("same recording is one result with selectable sources and confirmed explicit first", () => {
    const result = mergeServiceCatalogResults([youtube], [vk]);
    assert.equal(result.length, 1);
    assert.equal(result[0].musicSourceRecording?.id, "1_2");
    assert.equal(result[0].versions?.length, 2);
    assert.equal(result[0].versions?.[0].youtubeVideoId, "abcdefghijk");
});
test("live, cover and different durations remain separate recordings", () => {
    for (const other of [
        { ...vk, title: "Song (Live)" },
        { ...vk, title: "Song (Cover)" },
        { ...vk, duration: 210 },
        { ...vk, artists: ["Other"] },
    ]) {
        assert.equal(mergeServiceCatalogResults([youtube], [other]).length, 2);
    }
});
test("missing duration does not establish an exact recording match", () => {
    assert.equal(
        mergeServiceCatalogResults([{ ...youtube, duration: null }], [vk])
            .length,
        2,
    );
});
test("a preferred version cannot bridge recordings four seconds apart", () => {
    const result = mergeServiceCatalogResults(
        [youtube],
        [
            { ...vk, duration: 182 },
            { ...vk, id: "1_3", duration: 184 },
        ],
    );
    assert.equal(result.length, 2);
});
test("unknown explicitness keeps the original default and remains honestly labelled", () => {
    const result = mergeServiceCatalogResults(
        [youtube],
        [{ ...vk, contentVersion: "unknown" }],
    );
    assert.equal(result[0].youtubeVideoId, youtube.youtubeVideoId);
    assert.equal(
        result[0].versions?.[1].musicSourceRecording?.contentVersion,
        "unknown",
    );
});
test("artist and album rows are preserved and input arrays are not mutated", () => {
    const artist: DiscoverResult = { type: "music", name: "Artist" };
    const input = [artist, youtube];
    const before = JSON.stringify(input);
    const result = mergeServiceCatalogResults(input, [vk, vk]);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], artist);
    assert.equal(result[1].versions?.length, 2);
    assert.equal(JSON.stringify(input), before);
});
