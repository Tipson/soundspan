import assert from "node:assert/strict";
import { test } from "node:test";
import {
    toStreamingSearchTracks,
    excludeVisibleStreamingMatches,
} from "../../features/search/streamingSearchTracks";
import type { DiscoverResult } from "../../features/search/types";

const youtube = (id = "AAAAAAAAAAA") => ({
    id: `yt:${id}`,
    title: "Saved song",
    duration: 180,
    source: "youtube",
    streamSource: "youtube",
    youtubeVideoId: id,
    artist: { id: null, name: "Artist" },
    album: { id: null, title: "Album", coverArt: null },
});
const native = (provider: "vk" | "yandex", id: string) => ({
    id: `${provider}:${id}`,
    title: "Native song",
    duration: 190,
    source: provider,
    streamSource: provider,
    mediaSource: provider,
    provider: {
        source: provider,
        providerTrackId: id,
        tidalTrackId: null,
        youtubeVideoId: null,
    },
    artist: { id: null, name: "Artist, Guest" },
    musicSourceRecording: {
        provider,
        id,
        title: "Native song",
        artists: ["Artist", "Guest"],
        duration: 190,
        preview: false,
        contentVersion: "explicit",
    },
});

test("saved search retains exact YouTube/VK/Yandex identity and visible order", () => {
    const result = toStreamingSearchTracks([
        youtube(),
        native("vk", "-12_34"),
        native("yandex", "123"),
        youtube(),
    ]);
    assert.deepEqual(
        result.map((row) => row.id),
        ["yt:AAAAAAAAAAA", "vk:-12_34", "yandex:123"],
    );
    assert.equal(result[0].youtubeVideoId, "AAAAAAAAAAA");
    assert.equal(
        result[1].musicSourceRecording?.artists.join(", "),
        "Artist, Guest",
    );
    assert.equal(result[2].musicSourceRecording?.contentVersion, "explicit");
});

test("missing, malformed and conflicting optional data cannot invent playable favorites", () => {
    const badNative = { ...native("vk", "-12_34"), title: "unconfirmed" };
    assert.deepEqual(toStreamingSearchTracks(undefined), []);
    assert.deepEqual(toStreamingSearchTracks({}), []);
    assert.deepEqual(
        toStreamingSearchTracks([
            null,
            { id: "local" },
            youtube("bad"),
            badNative,
        ]),
        [],
    );
    assert.equal(
        toStreamingSearchTracks([badNative, native("vk", "-12_34")]).length,
        1,
    );
});

test("only visible exact identities are removed from ordinary results", () => {
    const saved = toStreamingSearchTracks([youtube()]);
    const same = saved[0];
    const metadata: DiscoverResult = {
        type: "track",
        name: same.name,
        artist: same.artist,
        duration: 180,
    };
    const another = toStreamingSearchTracks([youtube("BBBBBBBBBBB")])[0];
    assert.deepEqual(
        excludeVisibleStreamingMatches([same, metadata, another], saved),
        [metadata, another],
    );
    assert.deepEqual(excludeVisibleStreamingMatches([same, another], []), [
        same,
        another,
    ]);
});

test("a grouped provider result keeps its non-favorite exact versions without mutating the input", () => {
    const [saved] = toStreamingSearchTracks([youtube()]);
    const [other] = toStreamingSearchTracks([native("vk", "-12_34")]);
    const grouped: DiscoverResult = Object.freeze({
        ...saved,
        versions: Object.freeze([saved, other]) as unknown as DiscoverResult[],
    });
    const result = excludeVisibleStreamingMatches([grouped], [saved]);
    assert.equal(result.length, 1);
    assert.equal(result[0].musicSourceRecording?.id, "-12_34");
    assert.equal(grouped.versions?.length, 2);
});
