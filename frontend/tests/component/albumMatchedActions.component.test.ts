import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Album } from "../../features/album/types";

const calls = { downloads: [] as unknown[][], requests: [] as unknown[] };
mock.module("@/lib/api", {
    namedExports: {
        api: {
            downloadAlbum: async (...args: unknown[]) => {
                calls.downloads.push(args);
            },
        },
    },
});
mock.module("@/lib/download-context", {
    namedExports: {
        useDownloadContext: () => ({
            addPendingDownload: () => {},
            isPendingByMbid: () => false,
        }),
    },
});
mock.module("@/hooks/useMusicRequests", {
    namedExports: {
        useRequestsGate: () => ({ requestsEnabled: true }),
        useMyMusicRequests: () => ({ data: [] }),
        useCreateMusicRequest: () => ({
            isPending: false,
            mutateAsync: async (body: unknown) => {
                calls.requests.push(body);
            },
        }),
        openRequestRgMbids: () => new Set(),
    },
});
mock.module("sonner", {
    namedExports: {
        toast: {
            loading: () => {},
            success: () => {},
            error: () => {},
            info: () => {},
        },
    },
});

test("matched remote hooks submit only canonical acquisition UUID and preserve provider album identity", async () => {
    const { useAlbumRequest } =
        await import("../../features/album/hooks/useAlbumRequest");
    const { useAlbumAcquisition } =
        await import("../../features/album/hooks/useAlbumAcquisition");
    const rg = "11111111-1111-4111-8111-111111111111";
    const album: Album = {
        id: "stable-remote-album",
        title: "Album",
        rgMbid: "remote:stable",
        matchedRgMbid: rg,
        artist: {
            id: "stable-artist",
            name: "Artist",
            mbid: "temp-placeholder",
        },
    };
    await useAlbumRequest(album).requestAlbum();
    await useAlbumAcquisition()(album);
    assert.deepEqual(calls.requests, [
        { artistName: "Artist", albumTitle: "Album", rgMbid: rg },
    ]);
    assert.deepEqual(calls.downloads, [["Artist", "Album", rg]]);
    assert.equal(album.id, "stable-remote-album");
    assert.equal(album.rgMbid, "remote:stable");
    const held = { ...album, matchedInLibrary: true };
    await useAlbumRequest(held).requestAlbum();
    await useAlbumAcquisition()(held);
    assert.equal(calls.requests.length, 1);
    assert.equal(calls.downloads.length, 1);
});
