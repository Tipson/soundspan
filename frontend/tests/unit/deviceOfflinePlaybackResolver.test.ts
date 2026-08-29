import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
    clearDeviceOfflineRuntimeState,
    getDeviceOfflinePlaybackErrorMessage,
    prepareDeviceOfflinePlaybackSource,
    resolveDeviceOfflinePlaybackUrl,
    setDeviceOfflineRuntimeState,
} from "../../features/device-offline/playbackResolver";
import type { DeviceOfflineDownloadRecord } from "../../features/device-offline/types";

const TRACK = {
    id: "yt:video-a",
    title: "Alpha",
    artist: { name: "Artist A" },
    album: { title: "Single" },
    duration: 201,
    streamSource: "youtube" as const,
    youtubeVideoId: "video-a",
};

function readyRecord(
    ownerId: string,
    key: string,
): DeviceOfflineDownloadRecord {
    return {
        key,
        ownerId,
        trackIdentity: "youtube:video-a",
        quality: "auto",
        virtualUrl: `/__offline/audio/${key}`,
        sourceUrl: "/api/ytmusic/stream-public/video-a",
        track: TRACK,
        status: "ready",
        transferMode: "foreground",
        backgroundFetchId: null,
        bytesReceived: 6,
        totalBytes: 6,
        contentType: "audio/mp4",
        persistenceGranted: true,
        attempt: 1,
        createdAt: 1,
        updatedAt: 1,
        errorCode: null,
        errorMessage: null,
    };
}

afterEach(() => clearDeviceOfflineRuntimeState());

test("offline playback errors distinguish missing downloads from a damaged local copy", () => {
    assert.match(
        getDeviceOfflinePlaybackErrorMessage(false),
        /not downloaded to this device/i,
    );
    assert.match(
        getDeviceOfflinePlaybackErrorMessage(true),
        /downloaded copy could not be opened/i,
    );
});

test("a prepared CacheStorage blob is preferred without consulting the network URL", () => {
    const record = readyRecord("user-1", "ready-key");
    let revoked = 0;
    setDeviceOfflineRuntimeState("user-1", [record]);
    assert.equal(
        prepareDeviceOfflinePlaybackSource(
            "user-1",
            record,
            "blob:https://soundspan.test/device-copy",
            () => {
                revoked += 1;
            },
        ),
        true,
    );

    assert.equal(
        resolveDeviceOfflinePlaybackUrl(
            TRACK,
            "https://soundspan.test/api/ytmusic/stream-public/video-a",
        ),
        "blob:https://soundspan.test/device-copy",
    );
    assert.equal(revoked, 0);
});

test("prepared playback sources are account-scoped and revoked on owner change", () => {
    const userOne = readyRecord("user-1", "user-one-key");
    const userTwo = readyRecord("user-2", "user-two-key");
    let revoked = 0;

    setDeviceOfflineRuntimeState("user-1", [userOne]);
    prepareDeviceOfflinePlaybackSource(
        "user-1",
        userOne,
        "blob:https://soundspan.test/user-one",
        () => {
            revoked += 1;
        },
    );
    setDeviceOfflineRuntimeState("user-2", [userTwo]);

    assert.equal(revoked, 1);
    assert.equal(
        resolveDeviceOfflinePlaybackUrl(TRACK, "/network-user-two"),
        userTwo.virtualUrl,
    );
    assert.equal(
        prepareDeviceOfflinePlaybackSource(
            "user-1",
            userOne,
            "blob:https://soundspan.test/stale-user-one",
            () => {
                revoked += 1;
            },
        ),
        false,
    );
    assert.equal(revoked, 2);
});

test("reconciliation revokes a prepared source after its local record is removed", () => {
    const record = readyRecord("user-1", "evicted-key");
    let revoked = 0;
    setDeviceOfflineRuntimeState("user-1", [record]);
    prepareDeviceOfflinePlaybackSource(
        "user-1",
        record,
        "blob:https://soundspan.test/evicted",
        () => {
            revoked += 1;
        },
    );

    setDeviceOfflineRuntimeState("user-1", []);

    assert.equal(revoked, 1);
    assert.equal(
        resolveDeviceOfflinePlaybackUrl(TRACK, "/network-after-eviction"),
        "/network-after-eviction",
    );
});

test("local Blob playback sources stay bounded while preserving the current and previous track", () => {
    const first = readyRecord("user-1", "first-key");
    const second = {
        ...readyRecord("user-1", "second-key"),
        trackIdentity: "track:second",
        track: { ...TRACK, id: "second", youtubeVideoId: undefined },
    };
    const third = {
        ...readyRecord("user-1", "third-key"),
        trackIdentity: "track:third",
        track: { ...TRACK, id: "third", youtubeVideoId: undefined },
    };
    const revoked: string[] = [];
    setDeviceOfflineRuntimeState("user-1", [first, second, third]);

    for (const record of [first, second, third]) {
        prepareDeviceOfflinePlaybackSource(
            "user-1",
            record,
            `blob:https://soundspan.test/${record.key}`,
            () => revoked.push(record.key),
        );
    }

    assert.deepEqual(revoked, ["first-key"]);
    assert.equal(
        resolveDeviceOfflinePlaybackUrl(second.track, "/network-second"),
        "blob:https://soundspan.test/second-key",
    );
    assert.equal(
        resolveDeviceOfflinePlaybackUrl(third.track, "/network-third"),
        "blob:https://soundspan.test/third-key",
    );
});
