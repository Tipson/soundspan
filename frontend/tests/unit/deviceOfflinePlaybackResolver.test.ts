import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
    acquireDeviceOfflinePlaybackSource,
    clearDeviceOfflineRuntimeState,
    getDeviceOfflinePlaybackErrorMessage,
    hasDeviceOfflinePlaybackCopy,
    prepareDeviceOfflinePlaybackSource,
    resolveDeviceOfflineMediaIdentity,
    resolveDeviceOfflinePlaybackIdentity,
    resolveDeviceOfflinePlaybackUrl,
    setDeviceOfflineRuntimeState,
} from "../../features/device-offline/playbackResolver";
import type { DeviceOfflineDownloadRecord } from "../../features/device-offline/types";
import {
    DeviceAudioVaultError,
    installDeviceAudioVaultFactory,
    type DeviceAudioVault,
    type DeviceAudioVaultRef,
    type DeviceAudioVaultSession,
} from "../../features/device-offline/vault";
import { getAuthRuntimeGeneration } from "../../lib/auth-runtime-generation";

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

function fakeVault(open: DeviceAudioVault["open"]): DeviceAudioVault {
    return {
        inspectAccess: async () => ({
            status: "ready",
            code: null,
            storageKind: "desktop-directory",
            label: "Test music",
            reason: "Ready",
        }),
        requestAccess: async () => ({
            status: "ready",
            code: null,
            storageKind: "desktop-directory",
            label: "Test music",
            reason: "Ready",
        }),
        open,
    };
}

afterEach(() => clearDeviceOfflineRuntimeState());

test("offline playback errors distinguish missing downloads from a damaged local copy", () => {
    assert.match(
        getDeviceOfflinePlaybackErrorMessage(false),
        /не загружен на это устройство/i,
    );
    assert.match(
        getDeviceOfflinePlaybackErrorMessage(true),
        /не удалось открыть загруженную копию/i,
    );
});

test("playback identity is the stable ready-record key, not its transient URL", () => {
    const record = readyRecord("user-1", "stable-key");
    setDeviceOfflineRuntimeState("user-1", [record]);

    assert.equal(resolveDeviceOfflinePlaybackIdentity(TRACK), "stable-key");
    assert.equal(
        resolveDeviceOfflineMediaIdentity(TRACK),
        `${TRACK.id}\u0000stable-key`,
    );
    assert.equal(hasDeviceOfflinePlaybackCopy(TRACK), true);

    prepareDeviceOfflinePlaybackSource(
        "user-1",
        record,
        "blob:https://soundspan.test/transient",
        () => undefined,
    );

    assert.equal(resolveDeviceOfflinePlaybackIdentity(TRACK), "stable-key");
    assert.equal(hasDeviceOfflinePlaybackCopy(TRACK), true);
});

test("tracks without a verified ready record have no device playback identity", () => {
    setDeviceOfflineRuntimeState("user-1", []);

    assert.equal(resolveDeviceOfflinePlaybackIdentity(TRACK), null);
    assert.equal(resolveDeviceOfflineMediaIdentity(TRACK), TRACK.id);
    assert.equal(hasDeviceOfflinePlaybackCopy(TRACK), false);
});

test("managed device playback opens an owner-scoped vault lease", async (t) => {
    const record = {
        ...readyRecord("user-1", "managed-key"),
        mediaRef: "fsa1:owner:file" as DeviceAudioVaultRef,
    };
    const openCalls: Array<{ ownerId: string; authGeneration: number }> = [];
    const accessCalls: unknown[] = [];
    let releases = 0;
    const session = {
        ownerId: "user-1",
        authGeneration: getAuthRuntimeGeneration(),
        storage: { kind: "desktop-directory", label: "Test music" },
        retain: async () => {
            throw new Error("retain is not used by playback");
        },
        access: async (input: unknown) => {
            accessCalls.push(input);
            return {
                kind: "play",
                url: "blob:https://soundspan.test/managed",
                release: () => releases++,
            };
        },
    } as unknown as DeviceAudioVaultSession;
    const restore = installDeviceAudioVaultFactory(() =>
        fakeVault(async (input) => {
            openCalls.push(input);
            return session;
        }),
    );
    t.after(restore);
    setDeviceOfflineRuntimeState("user-1", [record]);

    const source = await acquireDeviceOfflinePlaybackSource(
        TRACK,
        "/network",
        new AbortController().signal,
    );

    assert.deepEqual(openCalls, [
        {
            ownerId: "user-1",
            authGeneration: getAuthRuntimeGeneration(),
        },
    ]);
    assert.deepEqual(accessCalls, [
        {
            kind: "play",
            ref: record.mediaRef,
            expectedBytes: 6,
        },
    ]);
    assert.equal(source.url, "blob:https://soundspan.test/managed");
    source.release();
    assert.equal(releases, 1);
});

test("an unverified legacy record falls back to the clean network URL", async (t) => {
    let openCalls = 0;
    const restore = installDeviceAudioVaultFactory(() =>
        fakeVault(async () => {
            openCalls += 1;
            throw new Error("legacy playback must not open the vault");
        }),
    );
    t.after(restore);
    const record = readyRecord("user-1", "legacy-key");
    setDeviceOfflineRuntimeState("user-1", [record]);

    const source = await acquireDeviceOfflinePlaybackSource(
        TRACK,
        "/network",
        new AbortController().signal,
    );

    assert.equal(source.url, "/network");
    assert.equal(openCalls, 0);
});

test("a prepared legacy record keeps using its verified local Blob URL", async () => {
    const record = readyRecord("user-1", "prepared-legacy-key");
    setDeviceOfflineRuntimeState("user-1", [record]);
    prepareDeviceOfflinePlaybackSource(
        "user-1",
        record,
        "blob:https://soundspan.test/prepared-legacy",
        () => undefined,
    );

    const source = await acquireDeviceOfflinePlaybackSource(
        TRACK,
        "/network",
        new AbortController().signal,
    );

    assert.equal(source.url, "blob:https://soundspan.test/prepared-legacy");
});

test("a recoverable vault access failure falls back to the clean network URL", async (t) => {
    const restore = installDeviceAudioVaultFactory(() =>
        fakeVault(async () => {
            throw new DeviceAudioVaultError(
                "permission_required",
                "Reconnect the selected folder",
                "user-action",
            );
        }),
    );
    t.after(restore);
    setDeviceOfflineRuntimeState("user-1", [
        {
            ...readyRecord("user-1", "permission-key"),
            mediaRef: "fsa1:owner:permission" as DeviceAudioVaultRef,
        },
    ]);

    const source = await acquireDeviceOfflinePlaybackSource(
        TRACK,
        "/network",
        new AbortController().signal,
    );

    assert.equal(source.url, "/network");
});

test("an offline cold-start never replaces a ready device file with an unreachable network URL", async (t) => {
    const previousNavigator = Object.getOwnPropertyDescriptor(
        globalThis,
        "navigator",
    );
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { onLine: false },
    });
    t.after(() => {
        if (previousNavigator) {
            Object.defineProperty(globalThis, "navigator", previousNavigator);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }
    });
    const localFailure = new DeviceAudioVaultError(
        "not_found",
        "The retained device file could not be opened",
        "retry",
    );
    const restore = installDeviceAudioVaultFactory(() =>
        fakeVault(async () => {
            throw localFailure;
        }),
    );
    t.after(restore);
    setDeviceOfflineRuntimeState("user-1", [
        {
            ...readyRecord("user-1", "cold-start-key"),
            mediaRef: "opfs1:owner:cold-start" as DeviceAudioVaultRef,
        },
    ]);

    await assert.rejects(
        acquireDeviceOfflinePlaybackSource(
            TRACK,
            "/network-that-cannot-work-offline",
            new AbortController().signal,
        ),
        (error: unknown) => error === localFailure,
    );
    assert.equal(hasDeviceOfflinePlaybackCopy(TRACK), true);
});

test("an aborted managed acquisition releases a late vault URL", async (t) => {
    let resolveAccess!: (value: unknown) => void;
    let releases = 0;
    const accessPromise = new Promise((resolve) => {
        resolveAccess = resolve;
    });
    const session = {
        ownerId: "user-1",
        authGeneration: getAuthRuntimeGeneration(),
        storage: { kind: "desktop-directory", label: "Test music" },
        retain: async () => {
            throw new Error("retain is not used by playback");
        },
        access: () => accessPromise,
    } as unknown as DeviceAudioVaultSession;
    const restore = installDeviceAudioVaultFactory(() =>
        fakeVault(async () => session),
    );
    t.after(restore);
    setDeviceOfflineRuntimeState("user-1", [
        {
            ...readyRecord("user-1", "late-key"),
            mediaRef: "fsa1:owner:late" as DeviceAudioVaultRef,
        },
    ]);
    const controller = new AbortController();

    const sourcePromise = acquireDeviceOfflinePlaybackSource(
        TRACK,
        "/network",
        controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    resolveAccess({
        kind: "play",
        url: "blob:https://soundspan.test/late",
        release: () => releases++,
    });

    await assert.rejects(
        sourcePromise,
        (error: unknown) =>
            error instanceof DOMException && error.name === "AbortError",
    );
    assert.equal(releases, 1);
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
        "/network-user-two",
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
