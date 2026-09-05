import assert from "node:assert/strict";
import test from "node:test";
import {
    deviceOfflineRecordMatchesTrack,
    resolveCompatibleDeviceOfflineRecordIdentity,
    resolveDeviceOfflineTrackIdentity,
} from "../../features/device-offline/trackIdentity";
import type {
    DeviceOfflineDownloadRecord,
    DeviceOfflineTrack,
} from "../../features/device-offline/types";

function track(
    id: string,
    overrides: Partial<DeviceOfflineTrack> = {},
): DeviceOfflineTrack {
    return {
        id,
        title: id,
        artist: { name: "Artist" },
        album: { title: "Album" },
        duration: 180,
        ...overrides,
    };
}

function readyRecord(
    trackIdentity: string,
    value: DeviceOfflineTrack,
    sourceUrl: string,
): DeviceOfflineDownloadRecord {
    return {
        key: `key-${trackIdentity.replace(":", "-")}`,
        ownerId: "owner-1",
        trackIdentity,
        quality: "auto",
        virtualUrl: "/__offline/audio/record-key",
        sourceUrl,
        track: value,
        status: "ready",
        transferMode: "foreground",
        backgroundFetchId: null,
        bytesReceived: 1024,
        totalBytes: 1024,
        contentType: "audio/mp4",
        persistenceGranted: true,
        attempt: 1,
        createdAt: 1,
        updatedAt: 1,
        errorCode: null,
        errorMessage: null,
    };
}

test("current device identity keeps real local and active YouTube ahead of stale provider ids", () => {
    assert.equal(
        resolveDeviceOfflineTrackIdentity(
            track("local-1", {
                filePath: "/music/local.flac",
                streamSource: "youtube",
                youtubeVideoId: "stale-video",
                tidalTrackId: 991,
            }),
        ),
        "track:local-1",
    );
    assert.equal(
        resolveDeviceOfflineTrackIdentity(
            track("tidal:992", {
                streamSource: "youtube",
                youtubeVideoId: "active-video",
                tidalTrackId: 992,
            }),
        ),
        "youtube:active-video",
    );
});

test("legacy remote keys expose a read alias only for an exact approved asset route", () => {
    const localFromTidal = readyRecord(
        "tidal:991",
        track("local-1", {
            source: "local",
            filePath: "/music/local.flac",
            tidalTrackId: 991,
        }),
        "/api/library/tracks/local-1/stream",
    );
    const localFromYouTube = readyRecord(
        "youtube:stale-video",
        track("local-2", {
            filePath: "/music/local-2.flac",
            streamSource: "youtube",
            youtubeVideoId: "stale-video",
        }),
        "/api/library/tracks/local-2/stream?quality=high",
    );
    const youtubeFromTidal = readyRecord(
        "tidal:992",
        track("tidal:992", {
            streamSource: "youtube",
            youtubeVideoId: "active-video",
            tidalTrackId: 992,
        }),
        "/api/ytmusic/stream-public/active-video",
    );

    assert.equal(
        resolveCompatibleDeviceOfflineRecordIdentity(localFromTidal),
        "track:local-1",
    );
    assert.equal(
        resolveCompatibleDeviceOfflineRecordIdentity(localFromYouTube),
        "track:local-2",
    );
    assert.equal(
        resolveCompatibleDeviceOfflineRecordIdentity(youtubeFromTidal),
        "youtube:active-video",
    );
    assert.equal(
        deviceOfflineRecordMatchesTrack(
            localFromTidal,
            track("local-1", { source: "local" }),
        ),
        true,
    );
    assert.equal(
        deviceOfflineRecordMatchesTrack(
            youtubeFromTidal,
            track("yt:active-video", {
                streamSource: "youtube",
                youtubeVideoId: "active-video",
            }),
        ),
        true,
    );
});

test("legacy aliases fail closed for retired, mismatched, and external provenance", () => {
    const base = track("local-1", {
        source: "local",
        filePath: "/music/local.flac",
        tidalTrackId: 991,
    });
    const unsafe = [
        readyRecord("tidal:991", base, "/api/tidal/stream/991"),
        readyRecord("tidal:991", base, "/api/library/tracks/different/stream"),
        readyRecord("tidal:992", base, "/api/library/tracks/local-1/stream"),
        readyRecord(
            "tidal:991",
            base,
            "https://other.example/api/library/tracks/local-1/stream",
        ),
        readyRecord(
            "tidal:991",
            base,
            "/\\other.example/api/library/tracks/local-1/stream",
        ),
    ];
    for (const record of unsafe) {
        assert.equal(
            resolveCompatibleDeviceOfflineRecordIdentity(record),
            null,
        );
        assert.equal(
            deviceOfflineRecordMatchesTrack(
                record,
                track("local-1", { source: "local" }),
            ),
            false,
        );
    }

    const retired = readyRecord(
        "tidal:991",
        track("tidal:991", {
            streamSource: "tidal",
            tidalTrackId: 991,
        }),
        "/api/ytmusic/stream-public/different-video",
    );
    assert.equal(
        deviceOfflineRecordMatchesTrack(retired, retired.track),
        false,
    );
});
