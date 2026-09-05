import assert from "node:assert/strict";
import test from "node:test";
import { getDeviceDownloadSourceUrl } from "../../features/device-offline/sourceUrl";

const baseTrack = {
    id: "track-1",
    title: "Track",
    artist: { name: "Artist" },
    album: { title: "Album" },
    duration: 180,
};

test("device source URL rejects retired TIDAL instead of falling through to a local route", () => {
    assert.throws(
        () =>
            getDeviceDownloadSourceUrl({
                ...baseTrack,
                id: "tidal:991",
                streamSource: "tidal",
                tidalTrackId: 991,
            }),
        /недоступен/i,
    );
});

test("device source URL rejects incomplete remote providers instead of guessing local", () => {
    assert.throws(
        () =>
            getDeviceDownloadSourceUrl({
                ...baseTrack,
                id: "remote-without-video",
                streamSource: "youtube",
            }),
        /youtube/i,
    );
});

test("device source URL honors active YouTube source over a legacy TIDAL id", () => {
    const sourceOnlyUrl = getDeviceDownloadSourceUrl({
        ...baseTrack,
        id: "tidal:991",
        source: "youtube",
        youtubeVideoId: "active-source-video",
    });
    const providerOnlyUrl = getDeviceDownloadSourceUrl({
        ...baseTrack,
        id: "tidal:992",
        provider: {
            source: "youtube",
            youtubeVideoId: "active-provider-video",
        },
    });

    assert.match(
        sourceOnlyUrl,
        /\/api\/ytmusic\/stream-public\/active-source-video$/,
    );
    assert.match(
        providerOnlyUrl,
        /\/api\/ytmusic\/stream-public\/active-provider-video$/,
    );
});

test("device source URL keeps a real local file with stale TIDAL metadata local", () => {
    const url = getDeviceDownloadSourceUrl({
        ...baseTrack,
        id: "local-with-stale-tidal",
        filePath: "/music/local.flac",
        streamSource: "tidal",
        tidalTrackId: 991,
    });

    assert.match(
        url,
        /\/api\/library\/tracks\/local-with-stale-tidal\/stream$/,
    );
});

test("device source URL keeps a real local file ahead of stale YouTube metadata", () => {
    const url = getDeviceDownloadSourceUrl({
        ...baseTrack,
        id: "local-with-stale-youtube",
        filePath: "/music/local.flac",
        streamSource: "youtube",
        youtubeVideoId: "stale-video",
    });

    assert.match(
        url,
        /\/api\/library\/tracks\/local-with-stale-youtube\/stream$/,
    );
});
