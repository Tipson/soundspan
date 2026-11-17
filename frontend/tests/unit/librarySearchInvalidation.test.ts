import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/queryKeys";

test("liked changes invalidate personal search pages without refetching provider catalogs", async () => {
    const client = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity } },
    });
    try {
        const ordinary = queryKeys.search("discover", "all", 20, "all");
        const pages = queryKeys.searchTracks("discover", "all");
        const provider = queryKeys.discoverSearch(
            "discover",
            "music",
            20,
            "all",
        );
        const native = queryKeys.serviceCatalog("discover");
        for (const key of [ordinary, pages, provider, native])
            client.setQueryData(key, { marker: true });
        await client.invalidateQueries({
            queryKey: queryKeys.librarySearchAll(),
        });
        assert.equal(client.getQueryState(ordinary)?.isInvalidated, true);
        assert.equal(client.getQueryState(pages)?.isInvalidated, true);
        assert.equal(client.getQueryState(provider)?.isInvalidated, false);
        assert.equal(client.getQueryState(native)?.isInvalidated, false);
    } finally {
        client.clear();
    }
});

test("saved membership invalidates its private result streams without refetching catalogs or liked tracks", async () => {
    const client = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity } },
    });
    const artists = queryKeys.savedMusicSearch("saved-music", "artist");
    const albums = queryKeys.savedMusicSearch("saved-music", "album");
    const liked = queryKeys.searchTracks("saved-music", "all");
    const provider = queryKeys.discoverSearch(
        "saved-music",
        "music",
        20,
        "all",
    );
    try {
        for (const key of [artists, albums, liked, provider])
            client.setQueryData(key, {});
        await client.invalidateQueries({
            queryKey: queryKeys.savedMusicSearchAll(),
        });
        assert.equal(client.getQueryState(artists)?.isInvalidated, true);
        assert.equal(client.getQueryState(albums)?.isInvalidated, true);
        assert.equal(client.getQueryState(liked)?.isInvalidated, false);
        assert.equal(client.getQueryState(provider)?.isInvalidated, false);
    } finally {
        client.clear();
    }
});
