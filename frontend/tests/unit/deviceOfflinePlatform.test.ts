import assert from "node:assert/strict";
import test from "node:test";
import {
    abortBrowserBackgroundFetch,
    backgroundFetchIdForKey,
    inspectBrowserServiceWorkerRegistration,
    resolveDeviceOfflineTransferCapability,
    startBrowserBackgroundFetch,
    sweepLegacyBrowserBackgroundFetches,
    type BackgroundFetchRegistrationLike,
    type BrowserServiceWorkerContainerLike,
} from "../../features/device-offline/platform";
import type { DeviceOfflineDownloadRecord } from "../../features/device-offline/types";

function activeDeviceOfflineWorker() {
    return {
        postMessage(
            message: unknown,
            transfer: readonly { postMessage: (value: unknown) => void }[] = [],
        ) {
            if (
                (message as { type?: string })?.type !==
                "DEVICE_OFFLINE_CAPABILITIES_REQUEST"
            ) {
                return;
            }
            transfer[0]?.postMessage({
                type: "DEVICE_OFFLINE_CAPABILITIES",
                backgroundFetchProtocol: 1,
            });
        },
    };
}

test("background registrations are isolated by download attempt", () => {
    assert.notEqual(
        backgroundFetchIdForKey("opaque:key", 1),
        backgroundFetchIdForKey("opaque:key", 2),
    );
    assert.match(backgroundFetchIdForKey("opaque:key", 2), /%3A.*::2$/);
});

test("Android uses the verified foreground path even when Background Fetch is exposed", () => {
    const backgroundFetch = {
        fetch: async () => ({ id: "download-1" }),
    } as unknown as BackgroundFetchRegistrationLike["backgroundFetch"];

    const withBackgroundFetch = resolveDeviceOfflineTransferCapability({
        userAgent: "Mozilla/5.0 (Linux; Android 15)",
        backgroundFetch,
    });
    const withoutBackgroundFetch = resolveDeviceOfflineTransferCapability({
        userAgent: "Mozilla/5.0 (Linux; Android 15)",
        backgroundFetch: undefined,
    });

    assert.equal(withBackgroundFetch.mode, "foreground");
    assert.equal(withoutBackgroundFetch.mode, "foreground");
    assert.equal(
        withBackgroundFetch.explanation,
        "Не закрывайте Soundspan, пока трек не будет сохранён и проверен на этом Android-устройстве. Прерванную загрузку можно повторить в разделе «Загрузки».",
    );
    assert.equal(
        withoutBackgroundFetch.explanation,
        withBackgroundFetch.explanation,
    );
});

test("iPhone remains honest foreground even if a partial vendor object is present", () => {
    const result = resolveDeviceOfflineTransferCapability({
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)",
        backgroundFetch: {
            fetch: async () => ({ id: "unexpected" }),
        } as unknown as BackgroundFetchRegistrationLike["backgroundFetch"],
    });

    assert.equal(result.mode, "foreground");
    assert.equal(
        result.explanation,
        "Не закрывайте Soundspan до завершения загрузки. На iPhone прерванная загрузка при повторе начнётся заново в активном приложении.",
    );
});

test("desktop explains the foreground-only download path in Russian", () => {
    const result = resolveDeviceOfflineTransferCapability({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        backgroundFetch: undefined,
    });

    assert.deepEqual(result, {
        mode: "foreground",
        explanation:
            "Не закрывайте Soundspan до завершения загрузки. Прерванную загрузку можно продолжить в разделе «Загрузки».",
    });
});

test("registration discovery is bounded and never waits for serviceWorker.ready", async () => {
    let readyWasRead = false;
    const serviceWorker = {
        get ready() {
            readyWasRead = true;
            return new Promise<never>(() => undefined);
        },
        getRegistration: () => new Promise<never>(() => undefined),
    } as unknown as BrowserServiceWorkerContainerLike;

    const result = await inspectBrowserServiceWorkerRegistration(
        serviceWorker,
        5,
    );

    assert.equal(result.state, "unknown");
    assert.equal(readyWasRead, false);
});

test("only an active service worker registration can expose Background Fetch", async () => {
    const inactive = await inspectBrowserServiceWorkerRegistration(
        {
            getRegistration: async () => ({
                active: null,
                backgroundFetch: {
                    fetch: async () => ({ id: "must-not-start" }),
                },
            }),
        },
        5,
    );
    const active = await inspectBrowserServiceWorkerRegistration(
        {
            getRegistration: async () => ({
                active: {},
                backgroundFetch: {
                    fetch: async () => ({ id: "download-1" }),
                },
            }),
        },
        5,
    );

    assert.equal(inactive.state, "unavailable");
    assert.equal(active.state, "active");
});

test("Android never starts the unreliable browser Background Fetch path", async () => {
    let backgroundFetchCalls = 0;
    const record = {
        key: "opaque-key",
        attempt: 1,
        totalBytes: 123,
        track: { title: "Slow registration" },
    } as DeviceOfflineDownloadRecord;

    const result = await startBrowserBackgroundFetch(
        record,
        "https://soundspan.test/api/ytmusic/stream-public/track-1",
        {
            serviceWorker: {
                getRegistration: async () => ({
                    active: activeDeviceOfflineWorker(),
                    backgroundFetch: {
                        fetch: async () => {
                            backgroundFetchCalls += 1;
                            return { id: "must-not-start" };
                        },
                    },
                }),
            },
            userAgent: "Mozilla/5.0 (Linux; Android 15)",
            lookupTimeoutMs: 5,
            operationTimeoutMs: 5,
        },
    );

    assert.equal(result, "unavailable");
    assert.equal(backgroundFetchCalls, 0);
});

test("legacy stalled Background Fetch cleanup aborts the Chrome system registration", async () => {
    const backgroundFetchId = "soundspan-device-audio-legacy-key::1";
    let requestedId: string | null = null;
    let abortCalls = 0;
    const record = {
        key: "legacy-key",
        attempt: 1,
        backgroundFetchId,
    } as DeviceOfflineDownloadRecord;

    const result = await abortBrowserBackgroundFetch(record, {
        serviceWorker: {
            getRegistration: async () => ({
                active: {},
                backgroundFetch: {
                    fetch: async () => ({ id: "unused" }),
                    get: async (id) => {
                        requestedId = id;
                        return {
                            id,
                            abort: async () => {
                                abortCalls += 1;
                                return true;
                            },
                        };
                    },
                },
            }),
        },
        lookupTimeoutMs: 5,
        operationTimeoutMs: 5,
    });

    assert.equal(requestedId, backgroundFetchId);
    assert.equal(abortCalls, 1);
    assert.equal(result, "cleared");
});

test("legacy cleanup preserves uncertainty when Chrome rejects, stalls, or declines abort", async () => {
    const record = {
        key: "legacy-key",
        attempt: 1,
        backgroundFetchId: "soundspan-device-audio-legacy-key::1",
    } as DeviceOfflineDownloadRecord;
    for (const abort of [
        async () => false,
        async () => {
            throw new Error("Chrome rejected abort");
        },
        () => new Promise<boolean>(() => undefined),
    ]) {
        assert.equal(
            await abortBrowserBackgroundFetch(record, {
                serviceWorker: {
                    getRegistration: async () => ({
                        active: {},
                        backgroundFetch: {
                            fetch: async () => ({ id: "unused" }),
                            get: async (id) => ({ id, abort }),
                        },
                    }),
                },
                lookupTimeoutMs: 5,
                operationTimeoutMs: 5,
            }),
            "unknown",
        );
    }
});

test("a missing legacy registration is confirmed cleared", async () => {
    const result = await abortBrowserBackgroundFetch(
        {
            key: "gone-key",
            attempt: 1,
            backgroundFetchId: "soundspan-device-audio-gone-key::1",
        } as DeviceOfflineDownloadRecord,
        {
            serviceWorker: {
                getRegistration: async () => ({
                    active: {},
                    backgroundFetch: {
                        fetch: async () => ({ id: "unused" }),
                        get: async () => undefined,
                    },
                }),
            },
            lookupTimeoutMs: 5,
            operationTimeoutMs: 5,
        },
    );
    assert.equal(result, "cleared");
});

test("legacy sweep retries orphaned Soundspan registrations without touching foreign downloads", async () => {
    const ownId = "soundspan-device-audio-orphan::1";
    const foreignId = "another-app-download";
    let abortAttempts = 0;
    const requested: string[] = [];
    const runtime = {
        serviceWorker: {
            getRegistration: async () => ({
                active: {},
                backgroundFetch: {
                    fetch: async () => ({ id: "unused" }),
                    getIds: async () => [ownId, foreignId],
                    get: async (id: string) => {
                        requested.push(id);
                        return {
                            id,
                            abort: async () => {
                                abortAttempts += 1;
                                return abortAttempts > 1;
                            },
                        };
                    },
                },
            }),
        },
        lookupTimeoutMs: 5,
        operationTimeoutMs: 5,
    };

    assert.equal(await sweepLegacyBrowserBackgroundFetches(runtime), "unknown");
    assert.equal(await sweepLegacyBrowserBackgroundFetches(runtime), "cleared");
    assert.deepEqual(requested, [ownId, ownId]);
});

test("legacy sweep does not turn a hung registration enumeration into an empty list", async () => {
    assert.equal(
        await sweepLegacyBrowserBackgroundFetches({
            serviceWorker: {
                getRegistration: async () => ({
                    active: {},
                    backgroundFetch: {
                        fetch: async () => ({ id: "unused" }),
                        getIds: () => new Promise<string[]>(() => undefined),
                        get: async () => undefined,
                    },
                }),
            },
            lookupTimeoutMs: 5,
            operationTimeoutMs: 5,
        }),
        "unknown",
    );
});

test("an older active worker without the device-offline protocol falls back to foreground", async () => {
    let backgroundFetchCalls = 0;
    const record = {
        key: "mixed-version-key",
        attempt: 1,
        totalBytes: null,
        track: { title: "Mixed version" },
    } as DeviceOfflineDownloadRecord;

    const result = await startBrowserBackgroundFetch(
        record,
        "https://soundspan.test/api/ytmusic/stream-public/track-1",
        {
            serviceWorker: {
                getRegistration: async () => ({
                    active: {
                        postMessage() {
                            // Previous Soundspan workers ignore this request.
                        },
                    },
                    backgroundFetch: {
                        fetch: async () => {
                            backgroundFetchCalls += 1;
                            return { id: "must-not-start" };
                        },
                    },
                }),
            },
            userAgent: "Mozilla/5.0 (Linux; Android 15)",
            lookupTimeoutMs: 5,
            operationTimeoutMs: 5,
        },
    );

    assert.equal(result, "unavailable");
    assert.equal(backgroundFetchCalls, 0);
});
