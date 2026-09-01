import assert from "node:assert/strict";
import test from "node:test";
import { mergeSearchAlbums } from "../../features/search/albumDedup";
import type { Album, DiscoverResult } from "../../features/search/types";

test("canonical provider albums replace sparse local shadows without duplicates", () => {
    const libraryAlbums: Album[] = [
        {
            id: "local-mezzanine",
            title: "Mezzanine",
            artist: { name: "Massive Attack" },
        },
    ];
    const providerAlbums: DiscoverResult[] = [
        {
            type: "album",
            id: "MPREb_mezzanine",
            browseId: "MPREb_mezzanine",
            name: "Mezzanine (Remastered)",
            artist: "Massive Attack",
        },
        {
            type: "album",
            id: "MPREb_heligoland",
            browseId: "MPREb_heligoland",
            name: "Heligoland",
            artist: "Massive Attack",
        },
        {
            type: "album",
            id: "MPREb_heligoland",
            browseId: "MPREb_heligoland",
            name: "Heligoland duplicate",
            artist: "Massive Attack",
        },
    ];

    const merged = mergeSearchAlbums(providerAlbums, libraryAlbums);
    assert.deepEqual(merged.libraryAlbums, []);
    assert.deepEqual(
        merged.discoverAlbums.map((result) => result.browseId),
        ["MPREb_mezzanine", "MPREb_heligoland"],
    );
});

test("meaningful parenthetical album titles are not treated as editions", () => {
    const libraryAlbums: Album[] = [
        {
            id: "local-music",
            title: "Music",
            artist: { name: "Example Artist" },
        },
    ];
    const providerAlbums: DiscoverResult[] = [
        {
            type: "album",
            browseId: "MPREb_music-for-airports",
            name: "Music (For Airports)",
            artist: "Example Artist",
        },
    ];

    const merged = mergeSearchAlbums(providerAlbums, libraryAlbums);
    assert.deepEqual(merged.libraryAlbums, libraryAlbums);
    assert.deepEqual(
        merged.discoverAlbums.map((result) => result.browseId),
        ["MPREb_music-for-airports"],
    );
});

test("a non-canonical discovery duplicate cannot displace a local album", () => {
    const libraryAlbums: Album[] = [
        {
            id: "local-from-zero",
            title: "From Zero",
            artist: { name: "Linkin Park" },
        },
    ];
    const providerAlbums: DiscoverResult[] = [
        {
            type: "album",
            name: "From Zero",
            artist: "Linkin Park",
        },
    ];

    assert.deepEqual(mergeSearchAlbums(providerAlbums, libraryAlbums), {
        libraryAlbums,
        discoverAlbums: [],
    });
});
