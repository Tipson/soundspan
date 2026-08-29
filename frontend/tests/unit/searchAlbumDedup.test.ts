import assert from "node:assert/strict";
import test from "node:test";
import { dedupeDiscoverAlbums } from "../../features/search/albumDedup";
import type { Album, DiscoverResult } from "../../features/search/types";

test("provider albums duplicate neither local albums nor each other", () => {
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

    assert.deepEqual(
        dedupeDiscoverAlbums(providerAlbums, libraryAlbums).map(
            (result) => result.browseId,
        ),
        ["MPREb_heligoland"],
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

    assert.deepEqual(
        dedupeDiscoverAlbums(providerAlbums, libraryAlbums).map(
            (result) => result.browseId,
        ),
        ["MPREb_music-for-airports"],
    );
});
