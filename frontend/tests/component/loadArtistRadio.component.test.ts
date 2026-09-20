import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { recordExplicitPlaybackPause } from "../../lib/audio-engine/playbackAdvanceOrigin";

let load: () => Promise<{ tracks: unknown[] }>;
const calls: unknown[][] = [];
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getRadioTracks: (...args: unknown[]) => {
                calls.push(args);
                return load();
            },
        },
    },
});
const track = {
    id: "yt:next0000001",
    title: "Next",
    duration: 180,
    artist: { name: "Related" },
    album: { title: "Album" },
    youtubeVideoId: "next0000001",
    streamSource: "youtube",
};

test("artist radio normalizes provider tracks before solo or shared queue handoff", async () => {
    const { loadArtistRadio } = await import("../../lib/radio/loadArtistRadio");
    load = async () => ({
        tracks: [track, { ...track, id: "alias" }, { id: "broken" }],
    });
    const result = await loadArtistRadio("artist-id");
    assert.deepEqual(calls.at(-1), ["artist", "artist-id"]);
    assert.equal(result?.length, 1);
    assert.equal(result?.[0].youtubeVideoId, "next0000001");
});

test("late artist radio response cannot replace a newer playback intent", async () => {
    const { loadArtistRadio } = await import("../../lib/radio/loadArtistRadio");
    let finish!: (value: { tracks: unknown[] }) => void;
    load = () =>
        new Promise((resolve) => {
            finish = resolve;
        });
    const pending = loadArtistRadio("artist-id");
    recordExplicitPlaybackPause();
    finish({ tracks: [track] });
    assert.equal(await pending, null);
});

test("direct provider artist radio does not send a virtual id to the local library lookup", async () => {
    const { loadArtistRadio } = await import("../../lib/radio/loadArtistRadio");
    load = async () => ({ tracks: [track] });
    await loadArtistRadio("ytartist:UC-example", "2CELLOS");
    assert.deepEqual(calls.at(-1), ["artist-name", "2CELLOS"]);
});

test("discovery artist radio resolves by name instead of querying a nonlocal MusicBrainz id", async () => {
    const { loadArtistRadio } = await import("../../lib/radio/loadArtistRadio");
    load = async () => ({ tracks: [track] });
    await loadArtistRadio("musicbrainz-id", "Artist", "discovery");
    assert.deepEqual(calls.at(-1), ["artist-name", "Artist"]);
});

test("empty and unavailable artist radio remain distinct", async () => {
    const { loadArtistRadio } = await import("../../lib/radio/loadArtistRadio");
    load = async () => ({ tracks: [] });
    assert.deepEqual(await loadArtistRadio("artist-id"), []);
    load = async () => {
        throw new Error("provider unavailable");
    };
    await assert.rejects(loadArtistRadio("artist-id"), /provider unavailable/);
});
