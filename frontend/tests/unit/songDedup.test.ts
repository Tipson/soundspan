import assert from "node:assert/strict";
import test from "node:test";
import {
    dedupeDiscoverTracks,
    normalizeSongKey,
} from "../../features/search/songDedup";
import type { DiscoverResult, LibraryTrack } from "../../features/search/types";

function libraryTrack(artist: string, title: string): LibraryTrack {
    return {
        id: `lib-${artist}-${title}`,
        title,
        duration: 200,
        album: {
            id: "al1",
            title: "Album",
            coverUrl: null,
            artist: { id: "ar1", name: artist },
        },
    } as unknown as LibraryTrack;
}

function discoverTrack(artist: string, name: string): DiscoverResult {
    return { type: "track", name, artist, duration: 200 };
}

test("normalizeSongKey folds case and punctuation but preserves recording versions", () => {
    assert.notEqual(
        normalizeSongKey("AC/DC", "T.N.T. (Live)"),
        normalizeSongKey("ac dc", "TNT"),
    );
    assert.notEqual(
        normalizeSongKey(
            "Trace Adkins",
            "Every Light In The House (2003 Remaster)",
        ),
        normalizeSongKey("trace adkins", "every light in the house"),
    );
    assert.notEqual(
        normalizeSongKey("Trace Adkins", "Songs About Me"),
        normalizeSongKey("Trace Adkins", "Chrome"),
    );
});

test("dedupeDiscoverTracks drops external rows that duplicate owned songs", () => {
    const deduped = dedupeDiscoverTracks(
        [
            discoverTrack("Trace Adkins", "Chrome"),
            discoverTrack("Trace Adkins", "Songs About Me"),
        ],
        [libraryTrack("Trace Adkins", "Chrome")],
    );
    assert.deepEqual(
        deduped.map((track) => track.name),
        ["Songs About Me"],
    );
});
test("library original does not hide live, different-length or unknown-length recordings", () => {
    const rows = [
        discoverTrack("A", "Song (Live)"),
        { ...discoverTrack("A", "Song"), duration: 250 },
        { ...discoverTrack("A", "Song"), duration: undefined },
    ];
    assert.deepEqual(
        dedupeDiscoverTracks(rows, [libraryTrack("A", "Song")]),
        rows,
    );
});
test("library title cannot erase an explicit source choice", () => {
    const track = {
        ...discoverTrack("A", "Song"),
        musicSourceRecording: {
            provider: "vk" as const,
            id: "1_2",
            title: "Song",
            artists: ["A"],
            duration: 200,
            contentVersion: "explicit" as const,
            preview: false,
        },
    };
    assert.deepEqual(
        dedupeDiscoverTracks([track], [libraryTrack("A", "Song")]),
        [track],
    );
});

test("dedupeDiscoverTracks keeps artist-less rows and everything when either side is empty", () => {
    const artistless: DiscoverResult = { type: "track", name: "Mystery" };
    assert.deepEqual(
        dedupeDiscoverTracks([artistless], [libraryTrack("A", "Mystery")]),
        [artistless],
    );
    const all = [discoverTrack("A", "B")];
    assert.deepEqual(dedupeDiscoverTracks(all, []), all);
    assert.deepEqual(dedupeDiscoverTracks([], [libraryTrack("A", "B")]), []);
});
