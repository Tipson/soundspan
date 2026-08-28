import assert from "node:assert/strict";
import test from "node:test";
import {
    backgroundFetchIdForKey,
    inspectBrowserServiceWorkerRegistration,
    resolveDeviceOfflineTransferCapability,
    startBrowserBackgroundFetch,
    type BackgroundFetchRegistrationLike,
    type BrowserServiceWorkerContainerLike,
} from "../../features/device-offline/platform";
import type { DeviceOfflineDownloadRecord } from "../../features/device-offline/types";

test("background registrations are isolated by download attempt", () => {
    assert.notEqual(
        backgroundFetchIdForKey("opaque:key", 1),
        backgroundFetchIdForKey("opaque:key", 2),
    );
    assert.match(backgroundFetchIdForKey("opaque:key", 2), /%3A.*::2$/);
});

test("Android uses Background Fetch only when the live registration exposes it", () => {
    const backgroundFetch = {
        fetch: async () => ({ id: "download-1" }),
    } as unknown as BackgroundFetchRegistrationLike["backgroundFetch"];

    assert.equal(
        resolveDeviceOfflineTransferCapability({
            userAgent: "Mozilla/5.0 (Linux; Android 15)",
            backgroundFetch,
        }).mode,
        "background",
    );
    assert.equal(
        resolveDeviceOfflineTransferCapability({
            userAgent: "Mozilla/5.0 (Linux; Android 15)",
            backgroundFetch: undefined,
        }).mode,
        "foreground",
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
    assert.match(result.explanation, /keep.*open|foreground/i);
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

test("an ambiguous Background Fetch start timeout never falls back to a duplicate foreground transfer", async () => {
    const pendingStart = new Promise<{ id: string }>(() => undefined);
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
                    active: {},
                    backgroundFetch: {
                        fetch: async () => pendingStart,
                    },
                }),
            },
            userAgent: "Mozilla/5.0 (Linux; Android 15)",
            lookupTimeoutMs: 5,
            operationTimeoutMs: 5,
        },
    );

    assert.equal(result, "unknown");
});
