import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
    clampForegroundLeaseClockSkew,
    DeviceOfflineDownloadManager,
    foregroundLeaseDisposition,
    interruptExpiredForegroundRecord,
    matchesDeviceOfflineRecordVersion,
    type DeviceOfflineMetadataStore,
} from "../../features/device-offline/downloadManager";
import type { DeviceOfflineDownloadRecord } from "../../features/device-offline/types";

const ORIGIN = "https://soundspan.test";
const serviceWorkerSource = readFileSync(
    new URL("../../public/sw.js", import.meta.url),
    "utf8",
);

function requestUrl(input: Request | string | { url: string }): string {
    const raw = typeof input === "string" ? input : input.url;
    return new URL(raw, ORIGIN).toString();
}

test("native completed preload is reused only by its session and cleared by the sender", async () => {
    let requests = 0;
    const harness = createHarness(async () => {
        requests += 1;
        return new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: {
                "Content-Type": "audio/mpeg",
                "Content-Length": "4",
                "Cache-Control": "private, max-age=120",
            },
        });
    });
    const url = `${ORIGIN}/api/ytmusic/stream-public/dQw4w9WgXcQ?preloadSession=11111111-1111-4111-8111-111111111111:1`;
    const preload = await harness.dispatch("fetch", {
        clientId: "owner",
        request: new Request(`${url}&purpose=preload`),
    });
    assert.ok(
        preload,
        "eligible real cookie-auth media requests are intercepted",
    );
    await preload.arrayBuffer();
    const interactive = await harness.dispatch("fetch", {
        clientId: "owner",
        request: new Request(url, { headers: { Range: "bytes=1-2" } }),
    });
    assert.equal(interactive?.status, 206);
    assert.deepEqual(
        [...new Uint8Array(await interactive!.arrayBuffer())],
        [2, 3],
    );
    assert.equal(requests, 1, "completed bytes avoid the second transfer");
    await harness.dispatch("message", {
        data: { type: "CLEAR_STREAM_PRELOAD_CACHE", clientId: "owner" },
        source: { id: "other" },
    });
    await harness.dispatch("fetch", {
        clientId: "owner",
        request: new Request(url),
    });
    assert.equal(
        requests,
        1,
        "another client's message cannot clear the owner's bytes",
    );
    await harness.dispatch("message", {
        data: { type: "CLEAR_STREAM_PRELOAD_CACHE" },
        source: { id: "owner" },
    });
    await harness.dispatch("fetch", {
        clientId: "owner",
        request: new Request(url),
    });
    assert.equal(requests, 2, "logout forces an authenticated network request");
    assert.deepEqual(
        await harness.caches.keys(),
        [],
        "online reuse does not create persistent offline downloads",
    );
});

class FakeCache {
    readonly values = new Map<string, Response>();
    readonly putKeys: string[] = [];
    failDeletes = false;

    async match(input: Request | string | { url: string }) {
        return this.values.get(requestUrl(input))?.clone();
    }

    async put(input: Request | string | { url: string }, response: Response) {
        const key = requestUrl(input);
        this.putKeys.push(key);
        this.values.set(key, response.clone());
    }

    async delete(input: Request | string | { url: string }) {
        if (this.failDeletes) throw new Error("cache cleanup failed");
        return this.values.delete(requestUrl(input));
    }

    async keys() {
        return [...this.values.keys()].map((url) => new Request(url));
    }
}

class FakeCacheStorage {
    readonly stores = new Map<string, FakeCache>();
    readonly deleted: string[] = [];

    async open(name: string) {
        let cache = this.stores.get(name);
        if (!cache) {
            cache = new FakeCache();
            this.stores.set(name, cache);
        }
        return cache;
    }

    async keys() {
        return [...this.stores.keys()];
    }

    async delete(name: string) {
        this.deleted.push(name);
        return this.stores.delete(name);
    }

    async match(input: Request | string | { url: string }) {
        for (const cache of this.stores.values()) {
            const response = await cache.match(input);
            if (response) return response;
        }
        return undefined;
    }
}

type FakeIdbRecord = Record<string, unknown> & { key: string };

class FakeIndexedDb {
    readonly records = new Map<string, FakeIdbRecord>();
    private initialized = false;
    private nextOpenBarrier: {
        signalStarted: () => void;
        released: Promise<void>;
    } | null = null;

    pauseNextOpen(): { started: Promise<void>; release: () => void } {
        let signalStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            signalStarted = resolve;
        });
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.nextOpenBarrier = { signalStarted, released };
        return { started, release };
    }

    open() {
        const objectStoreNames = {
            contains: (name: string) =>
                this.initialized && name === "downloads",
        };
        const database = {
            objectStoreNames,
            createObjectStore: () => {
                this.initialized = true;
            },
            transaction: () => {
                const transaction: {
                    error: Error | null;
                    oncomplete: (() => void) | null;
                    onerror: (() => void) | null;
                    onabort: (() => void) | null;
                    abort: () => void;
                    objectStore: () => {
                        get: (key: string) => Record<string, unknown>;
                        put: (record: FakeIdbRecord) => void;
                    };
                } = {
                    error: null,
                    oncomplete: null,
                    onerror: null,
                    onabort: null,
                    abort() {
                        queueMicrotask(() => transaction.onabort?.());
                    },
                    objectStore: () => ({
                        get: (key: string) => {
                            const request: Record<string, unknown> & {
                                result?: FakeIdbRecord;
                                onsuccess?: () => void;
                                onerror?: () => void;
                            } = {};
                            queueMicrotask(() => {
                                const existing = this.records.get(key);
                                request.result = existing
                                    ? structuredClone(existing)
                                    : undefined;
                                request.onsuccess?.();
                                queueMicrotask(() =>
                                    transaction.oncomplete?.(),
                                );
                            });
                            return request;
                        },
                        put: (record: FakeIdbRecord) => {
                            this.records.set(
                                record.key,
                                structuredClone(record),
                            );
                        },
                    }),
                };
                return transaction;
            },
            close() {},
        };
        const request: {
            result: typeof database;
            error: Error | null;
            onupgradeneeded: (() => void) | null;
            onsuccess: (() => void) | null;
            onerror: (() => void) | null;
        } = {
            result: database,
            error: null,
            onupgradeneeded: null,
            onsuccess: null,
            onerror: null,
        };
        queueMicrotask(async () => {
            const barrier = this.nextOpenBarrier;
            this.nextOpenBarrier = null;
            if (barrier) {
                barrier.signalStarted();
                await barrier.released;
            }
            if (!this.initialized) request.onupgradeneeded?.();
            request.onsuccess?.();
        });
        return request;
    }
}

class SharedMapMetadataStore implements DeviceOfflineMetadataStore {
    constructor(private readonly records: Map<string, FakeIdbRecord>) {}

    private record(key: string): DeviceOfflineDownloadRecord | null {
        return (
            (this.records.get(key) as unknown as
                | DeviceOfflineDownloadRecord
                | undefined) ?? null
        );
    }

    async listByOwner(ownerId: string): Promise<DeviceOfflineDownloadRecord[]> {
        return [...this.records.values()]
            .filter((record) => record.ownerId === ownerId)
            .map(
                (record) =>
                    structuredClone(
                        record,
                    ) as unknown as DeviceOfflineDownloadRecord,
            );
    }

    async getByKey(key: string): Promise<DeviceOfflineDownloadRecord | null> {
        const record = this.record(key);
        return record ? structuredClone(record) : null;
    }

    async getByTrackQuality(
        ownerId: string,
        trackIdentity: string,
        quality: string,
    ): Promise<DeviceOfflineDownloadRecord | null> {
        return (
            ([...this.records.values()].find(
                (record) =>
                    record.ownerId === ownerId &&
                    record.trackIdentity === trackIdentity &&
                    record.quality === quality,
            ) as DeviceOfflineDownloadRecord | undefined) ?? null
        );
    }

    async claimReplacement(
        expected: DeviceOfflineDownloadRecord | null,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        if (isAuthorized && !isAuthorized()) return false;
        const current = await this.getByTrackQuality(
            next.ownerId,
            next.trackIdentity,
            next.quality,
        );
        const canClaim = expected
            ? matchesDeviceOfflineRecordVersion(current, expected)
            : current === null;
        if (!canClaim) return false;
        if (current) this.records.delete(current.key);
        await this.put(next);
        return true;
    }

    async put(record: DeviceOfflineDownloadRecord): Promise<void> {
        this.records.set(
            record.key,
            structuredClone(record) as unknown as FakeIdbRecord,
        );
    }

    async putIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        if (isAuthorized && !isAuthorized()) return false;
        if (
            !matchesDeviceOfflineRecordVersion(
                this.record(expected.key),
                expected,
            )
        ) {
            return false;
        }
        await this.put(next);
        return true;
    }

    async putAutoManagedIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        if (isAuthorized && !isAuthorized()) return false;
        const current = this.record(expected.key);
        if (
            current?.management !== "auto-liked" ||
            expected.management !== "auto-liked" ||
            !matchesDeviceOfflineRecordVersion(current, expected)
        ) {
            return false;
        }
        await this.put(next);
        return true;
    }

    async interruptForegroundIfLeaseExpired(
        expected: DeviceOfflineDownloadRecord,
        now: number,
    ): Promise<boolean> {
        const current = this.record(expected.key);
        if (
            !current ||
            !matchesDeviceOfflineRecordVersion(current, expected) ||
            current.status !== "downloading"
        ) {
            return false;
        }
        const disposition = foregroundLeaseDisposition(current, now);
        if (disposition === "live") return false;
        if (disposition === "clamp") {
            await this.put(clampForegroundLeaseClockSkew(current, now));
            return false;
        }
        await this.put(interruptExpiredForegroundRecord(current, now));
        return true;
    }

    async deleteIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        if (isAuthorized && !isAuthorized()) return false;
        if (
            !matchesDeviceOfflineRecordVersion(
                this.record(expected.key),
                expected,
            )
        ) {
            return false;
        }
        return this.records.delete(expected.key);
    }

    async deleteAutoManagedIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        if (isAuthorized && !isAuthorized()) return false;
        const current = this.record(expected.key);
        if (
            current?.management !== "auto-liked" ||
            expected.management !== "auto-liked" ||
            !matchesDeviceOfflineRecordVersion(current, expected)
        ) {
            return false;
        }
        return this.records.delete(expected.key);
    }
}

type Listener = (event: Record<string, unknown>) => void;
type HarnessTimers = {
    setTimeout: (callback: () => void, delayMs?: number) => unknown;
    clearTimeout: (handle: unknown) => void;
};

function createHarness(
    fetchImpl: (
        request: Request | { url: string },
    ) => Promise<Response> = async () => {
        throw new TypeError("offline");
    },
    timerOverrides?: HarnessTimers,
    clientNavigateResults: readonly ("resolve" | "reject")[] = ["resolve"],
) {
    const listeners = new Map<string, Listener[]>();
    const caches = new FakeCacheStorage();
    const indexedDB = new FakeIndexedDb();
    const clientMessages: unknown[] = [];
    const clientNavigations: string[] = [];
    const legacyBackgroundFetches = new Map<
        string,
        { id: string; abort: () => Promise<boolean> }
    >();
    let skipWaitingCalls = 0;
    let claimCalls = 0;

    const self = {
        location: { origin: ORIGIN },
        navigator: { onLine: true },
        registration: {
            backgroundFetch: {
                async getIds() {
                    return [...legacyBackgroundFetches.keys()];
                },
                async get(id: string) {
                    return legacyBackgroundFetches.get(id);
                },
            },
        },
        addEventListener(type: string, listener: Listener) {
            const current = listeners.get(type) ?? [];
            current.push(listener);
            listeners.set(type, current);
        },
        skipWaiting() {
            skipWaitingCalls += 1;
        },
        clients: {
            async claim() {
                claimCalls += 1;
            },
            async matchAll() {
                return clientNavigateResults.map((result, index) => ({
                    url:
                        index === 0
                            ? `${ORIGIN}/library?tab=downloads`
                            : `${ORIGIN}/search?client=${index}`,
                    postMessage(message: unknown) {
                        clientMessages.push(structuredClone(message));
                    },
                    async navigate(url: string) {
                        clientNavigations.push(url);
                        if (result === "reject") {
                            throw new Error("client navigation failed");
                        }
                        return this;
                    },
                }));
            },
        },
    };

    const context = vm.createContext({
        self,
        caches,
        indexedDB,
        fetch: fetchImpl,
        Request,
        Response,
        Headers,
        URL,
        Blob,
        Uint8Array,
        ReadableStream,
        AbortController,
        setTimeout:
            timerOverrides?.setTimeout ??
            ((callback: () => void, delayMs?: number) =>
                setTimeout(callback, delayMs)),
        clearTimeout:
            timerOverrides?.clearTimeout ??
            ((handle: unknown) =>
                clearTimeout(handle as ReturnType<typeof setTimeout>)),
        console,
        importScripts(path: string) {
            assert.equal(path, "/stream-preload-cache.js");
            vm.runInContext(
                readFileSync(
                    new URL(
                        "../../public/stream-preload-cache.js",
                        import.meta.url,
                    ),
                    "utf8",
                ),
                context,
                { filename: "stream-preload-cache.js" },
            );
        },
    });
    vm.runInContext(serviceWorkerSource, context, { filename: "sw.js" });

    async function dispatch(
        type: string,
        eventInit: Record<string, unknown> = {},
    ): Promise<Response | undefined> {
        const waits: Promise<unknown>[] = [];
        let responsePromise: Promise<Response> | undefined;
        const event = {
            ...eventInit,
            waitUntil(promise: Promise<unknown>) {
                waits.push(Promise.resolve(promise));
            },
            respondWith(promise: Promise<Response> | Response) {
                responsePromise = Promise.resolve(promise);
            },
        };

        for (const listener of listeners.get(type) ?? []) {
            listener(event);
        }
        await Promise.all(waits);
        return responsePromise ? await responsePromise : undefined;
    }

    return {
        navigator: self.navigator,
        caches,
        indexedDB,
        clientMessages,
        clientNavigations,
        addLegacyBackgroundFetch(
            id: string,
            abort: () => Promise<boolean> = async () => true,
        ) {
            legacyBackgroundFetches.set(id, {
                id,
                abort: async () => {
                    const result = await abort();
                    if (result) legacyBackgroundFetches.delete(id);
                    return result;
                },
            });
        },
        hasLegacyBackgroundFetch(id: string) {
            return legacyBackgroundFetches.has(id);
        },
        dispatch,
        get skipWaitingCalls() {
            return skipWaitingCalls;
        },
        get claimCalls() {
            return claimCalls;
        },
    };
}

function downloadingRecord(
    key: string,
    overrides: Partial<FakeIdbRecord> = {},
): FakeIdbRecord {
    return {
        key,
        ownerId: "user-one",
        status: "downloading",
        transferMode: "background",
        backgroundFetchId: `soundspan-device-audio-${key}`,
        bytesReceived: 0,
        totalBytes: null,
        contentType: null,
        updatedAt: 1,
        errorCode: null,
        errorMessage: null,
        ...overrides,
    };
}

function backgroundFetchRegistration(
    key: string,
    response?: Response,
    id = `soundspan-device-audio-${key}`,
) {
    return {
        id,
        async matchAll() {
            return response
                ? [{ responseReady: Promise.resolve(response) }]
                : [];
        },
    };
}

test("background fetch success stores audio, marks its record ready, and notifies open clients", async () => {
    const harness = createHarness();
    const systemUiUpdates: unknown[] = [];
    const key = "background-key";
    const registrationId = `soundspan-device-audio-${key}::1`;
    harness.indexedDB.records.set(
        key,
        downloadingRecord(key, {
            backgroundFetchId: registrationId,
            foregroundLeaseId: "registration-start-lease",
            foregroundLeaseExpiresAt: 50_000,
        }),
    );

    await harness.dispatch("backgroundfetchsuccess", {
        registration: backgroundFetchRegistration(
            key,
            new Response(Uint8Array.from([4, 3, 2, 1]), {
                status: 200,
                headers: {
                    "content-type": "audio/mpeg",
                    "content-length": "4",
                },
            }),
            registrationId,
        ),
        updateUI: async (value: unknown) =>
            systemUiUpdates.push(structuredClone(value)),
    });

    const audioCache = await harness.caches.open("soundspan-device-audio-v1");
    const cached = await audioCache.match(
        `${ORIGIN}/__offline/audio/background-key`,
    );
    assert.ok(cached);
    assert.equal(cached.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(
        new Uint8Array(await cached.arrayBuffer()),
        Uint8Array.from([4, 3, 2, 1]),
    );
    const stored = harness.indexedDB.records.get(key);
    assert.equal(stored?.status, "ready");
    assert.equal(stored?.transferMode, "background");
    assert.equal(stored?.backgroundFetchId, null);
    assert.equal(stored?.foregroundLeaseId, null);
    assert.equal(stored?.foregroundLeaseExpiresAt, null);
    assert.equal(stored?.bytesReceived, 4);
    assert.equal(stored?.totalBytes, 4);
    assert.equal(stored?.integrityVersion, 1);
    assert.equal(stored?.contentType, "audio/mpeg");
    assert.equal(stored?.errorCode, null);
    assert.equal(stored?.errorMessage, null);
    assert.deepEqual(harness.clientMessages, [
        { type: "DEVICE_OFFLINE_CHANGED", key, status: "ready" },
    ]);
    assert.deepEqual(systemUiUpdates, [{ title: "Загрузка сохранена" }]);
});

test("background success measures a body when Content-Length is absent", async () => {
    const harness = createHarness();
    const key = "chunked-background-key";
    const registrationId = `soundspan-device-audio-${key}::1`;
    harness.indexedDB.records.set(
        key,
        downloadingRecord(key, {
            backgroundFetchId: registrationId,
            updatedAt: Date.now(),
        }),
    );

    await harness.dispatch("backgroundfetchsuccess", {
        registration: backgroundFetchRegistration(
            key,
            new Response(Uint8Array.from([8, 6, 4, 2]), {
                status: 200,
                headers: { "content-type": "audio/mpeg" },
            }),
            registrationId,
        ),
    });

    const audioCache = await harness.caches.open("soundspan-device-audio-v1");
    const cached = await audioCache.match(`${ORIGIN}/__offline/audio/${key}`);
    assert.equal(cached?.headers.get("content-length"), null);
    const stored = harness.indexedDB.records.get(key);
    assert.equal(stored?.status, "ready");
    assert.equal(stored?.bytesReceived, 4);
    assert.equal(stored?.totalBytes, 4);
});

test("background success never publishes ready when the retained body is shorter than Content-Length", async () => {
    const harness = createHarness();
    const key = "truncated-background-key";
    const registrationId = `soundspan-device-audio-${key}::1`;
    harness.indexedDB.records.set(
        key,
        downloadingRecord(key, {
            backgroundFetchId: registrationId,
            updatedAt: Date.now(),
        }),
    );

    await harness.dispatch("backgroundfetchsuccess", {
        registration: backgroundFetchRegistration(
            key,
            new Response(Uint8Array.from([8, 6, 4, 2]), {
                status: 200,
                headers: {
                    "content-type": "audio/mpeg",
                    "content-length": "8",
                },
            }),
            registrationId,
        ),
    });

    const audioCache = await harness.caches.open("soundspan-device-audio-v1");
    assert.equal(
        await audioCache.match(`${ORIGIN}/__offline/audio/${key}`),
        undefined,
    );
    const stored = harness.indexedDB.records.get(key);
    assert.equal(stored?.status, "interrupted");
    assert.equal(stored?.backgroundFetchId, null);
    assert.equal(stored?.errorCode, "background_failed");
    assert.match(String(stored?.errorMessage), /размер|неполный|байт/i);
    assert.deepEqual(harness.clientMessages, [
        { type: "DEVICE_OFFLINE_CHANGED", key, status: "interrupted" },
    ]);
});

test("background failure remains retryable when best-effort cache cleanup rejects", async () => {
    const harness = createHarness();
    const key = "cleanup-failure-key";
    const registrationId = `soundspan-device-audio-${key}::1`;
    harness.indexedDB.records.set(
        key,
        downloadingRecord(key, {
            backgroundFetchId: registrationId,
            updatedAt: Date.now(),
        }),
    );
    const audioCache = await harness.caches.open("soundspan-device-audio-v1");
    audioCache.failDeletes = true;

    await harness.dispatch("backgroundfetchsuccess", {
        registration: backgroundFetchRegistration(
            key,
            new Response("provider failure", { status: 503 }),
            registrationId,
        ),
    });

    const stored = harness.indexedDB.records.get(key);
    assert.equal(stored?.status, "interrupted");
    assert.equal(stored?.errorCode, "background_failed");
    assert.deepEqual(harness.clientMessages, [
        { type: "DEVICE_OFFLINE_CHANGED", key, status: "interrupted" },
    ]);
});

test("reconcile winner-first grace lets the worker claim and publish background success", async () => {
    const harness = createHarness();
    const key = "background-completion-key";
    const registrationId = `soundspan-device-audio-${key}::1`;
    harness.indexedDB.records.set(
        key,
        downloadingRecord(key, {
            backgroundFetchId: registrationId,
            updatedAt: Date.now(),
        }),
    );
    const workerOpen = harness.indexedDB.pauseNextOpen();
    let releaseResponse!: (response: Response) => void;
    const responseReady = new Promise<Response>((resolve) => {
        releaseResponse = resolve;
    });
    const pending = harness.dispatch("backgroundfetchsuccess", {
        registration: {
            id: registrationId,
            async matchAll() {
                return [{ responseReady }];
            },
        },
    });
    await workerOpen.started;

    const manager = new DeviceOfflineDownloadManager({
        metadataStore: new SharedMapMetadataStore(harness.indexedDB.records),
        audioCache: {
            async put() {},
            async match() {
                return null;
            },
            async delete() {},
        },
        fetch: async () => {
            throw new TypeError("not used by reconcile");
        },
        now: Date.now,
        createKey: () => "not-used",
        origin: ORIGIN,
        requestPersistentStorage: async () => null,
        estimateStorage: async () => null,
        startBackgroundFetch: async () => "unavailable",
        abortBackgroundFetch: async () => "cleared",
        listActiveBackgroundFetches: async () => [],
        scheduleLeaseHeartbeat: () => Symbol("not-used"),
        cancelLeaseHeartbeat: () => undefined,
        scheduleLeaseExpiryCheck: () => Symbol("not-used"),
        cancelLeaseExpiryCheck: () => undefined,
        getAuthRuntimeLease: () => ({
            generation: 0,
            signal: new AbortController().signal,
        }),
        isAuthRuntimeCurrent: (generation) => generation === 0,
    });
    assert.equal(
        (await manager.reconcile("user-one"))[0]?.status,
        "downloading",
    );
    assert.match(
        String(harness.indexedDB.records.get(key)?.foregroundLeaseId),
        /^background-missing:/,
    );

    workerOpen.release();
    releaseResponse(
        new Response(Uint8Array.from([1, 3, 5, 7]), {
            status: 200,
            headers: { "content-length": "4" },
        }),
    );
    await pending;

    const stored = harness.indexedDB.records.get(key);
    assert.equal(stored?.status, "ready");
    assert.equal(stored?.foregroundLeaseId, null);
    const audioCache = await harness.caches.open("soundspan-device-audio-v1");
    assert.ok(await audioCache.match(`${ORIGIN}/__offline/audio/${key}`));
});

test("background fetch success removes its orphan cache entry when the record was deleted", async () => {
    const harness = createHarness();
    const systemUiUpdates: unknown[] = [];
    const key = "deleted-key";

    await harness.dispatch("backgroundfetchsuccess", {
        registration: backgroundFetchRegistration(
            key,
            new Response(Uint8Array.from([1, 2, 3]), {
                status: 200,
                headers: { "content-length": "3" },
            }),
        ),
        updateUI: async (value: unknown) =>
            systemUiUpdates.push(structuredClone(value)),
    });

    const audioCache = await harness.caches.open("soundspan-device-audio-v1");
    assert.equal(
        await audioCache.match(`${ORIGIN}/__offline/audio/deleted-key`),
        undefined,
    );
    assert.deepEqual(harness.clientMessages, []);
    assert.deepEqual(systemUiUpdates, [{ title: "Загрузка остановлена" }]);
});

test("a stale background success cannot overwrite a newer attempt or its cache", async () => {
    const harness = createHarness();
    const key = "retried-key";
    const staleId = `soundspan-device-audio-${key}::1`;
    const currentId = `soundspan-device-audio-${key}::2`;
    const current = downloadingRecord(key, {
        attempt: 2,
        backgroundFetchId: currentId,
    });
    harness.indexedDB.records.set(key, current);
    const audioCache = await harness.caches.open("soundspan-device-audio-v1");
    await audioCache.put(
        `${ORIGIN}/__offline/audio/${key}`,
        new Response(Uint8Array.from([9, 9, 9])),
    );

    await harness.dispatch("backgroundfetchsuccess", {
        registration: backgroundFetchRegistration(
            key,
            new Response(Uint8Array.from([1, 2, 3]), {
                status: 200,
                headers: { "content-length": "3" },
            }),
            staleId,
        ),
    });

    assert.deepEqual(harness.indexedDB.records.get(key), current);
    assert.deepEqual(
        new Uint8Array(
            await (await audioCache.match(
                `${ORIGIN}/__offline/audio/${key}`,
            ))!.arrayBuffer(),
        ),
        Uint8Array.from([9, 9, 9]),
    );
    assert.deepEqual(harness.clientMessages, []);
});

test("an old background success stages privately when a new opaque attempt wins mid-event", async () => {
    const harness = createHarness();
    const oldKey = "old-background-key";
    const newKey = "new-ready-key";
    const registrationId = `soundspan-device-audio-${oldKey}::1`;
    harness.indexedDB.records.set(
        oldKey,
        downloadingRecord(oldKey, { backgroundFetchId: registrationId }),
    );
    let signalResponseRequested!: () => void;
    const responseRequested = new Promise<void>((resolve) => {
        signalResponseRequested = resolve;
    });
    let releaseResponse!: (response: Response) => void;
    const responseReady = new Promise<Response>((resolve) => {
        releaseResponse = resolve;
    });
    const pending = harness.dispatch("backgroundfetchsuccess", {
        registration: {
            id: registrationId,
            async matchAll() {
                signalResponseRequested();
                return [{ responseReady }];
            },
        },
    });
    await responseRequested;

    const winner = downloadingRecord(newKey, {
        status: "ready",
        transferMode: "foreground",
        backgroundFetchId: null,
        attempt: 2,
    });
    harness.indexedDB.records.delete(oldKey);
    harness.indexedDB.records.set(newKey, winner);
    const audioCache = await harness.caches.open("soundspan-device-audio-v1");
    const winnerUrl = `${ORIGIN}/__offline/audio/${newKey}`;
    await audioCache.put(winnerUrl, new Response(Uint8Array.from([9, 8, 7])));
    releaseResponse(
        new Response(Uint8Array.from([1, 2, 3]), {
            status: 200,
            headers: { "content-length": "3" },
        }),
    );
    await pending;

    assert.deepEqual(harness.indexedDB.records.get(newKey), winner);
    assert.deepEqual(
        new Uint8Array(
            await (await audioCache.match(winnerUrl))!.arrayBuffer(),
        ),
        Uint8Array.from([9, 8, 7]),
    );
    assert.equal(
        await audioCache.match(`${ORIGIN}/__offline/audio/${oldKey}`),
        undefined,
    );
    assert.equal(
        audioCache.putKeys.includes(`${ORIGIN}/__offline/audio/${oldKey}`),
        false,
    );
    assert.equal(
        audioCache.putKeys.some((key) =>
            key.startsWith(`${ORIGIN}/__offline/audio-temp/`),
        ),
        true,
    );
    assert.deepEqual(harness.clientMessages, []);
});

for (const [eventType, expectedCode] of [
    ["backgroundfetchfail", "background_failed"],
    ["backgroundfetchabort", "interrupted"],
] as const) {
    test(`${eventType} marks an existing device download interrupted`, async () => {
        const harness = createHarness();
        const key = `${eventType}-key`;
        harness.indexedDB.records.set(key, downloadingRecord(key));

        await harness.dispatch(eventType, {
            registration: backgroundFetchRegistration(key),
        });

        const record = harness.indexedDB.records.get(key);
        assert.equal(record?.status, "interrupted");
        assert.equal(record?.backgroundFetchId, null);
        assert.equal(record?.foregroundLeaseId, null);
        assert.equal(record?.foregroundLeaseExpiresAt, null);
        assert.equal(record?.errorCode, expectedCode);
        assert.deepEqual(harness.clientMessages, [
            {
                type: "DEVICE_OFFLINE_CHANGED",
                key,
                status: "interrupted",
            },
        ]);
    });

    test(`${eventType} ignores an event from an older attempt`, async () => {
        const harness = createHarness();
        const key = `${eventType}-retried-key`;
        const currentId = `soundspan-device-audio-${key}::2`;
        const current = downloadingRecord(key, {
            attempt: 2,
            backgroundFetchId: currentId,
        });
        harness.indexedDB.records.set(key, current);

        await harness.dispatch(eventType, {
            registration: backgroundFetchRegistration(
                key,
                undefined,
                `soundspan-device-audio-${key}::1`,
            ),
        });

        assert.deepEqual(harness.indexedDB.records.get(key), current);
        assert.deepEqual(harness.clientMessages, []);
    });
}

test("background events also require downloading background state", async () => {
    for (const [status, transferMode] of [
        ["ready", "background"],
        ["downloading", "foreground"],
    ] as const) {
        const harness = createHarness();
        const key = `${status}-${transferMode}`;
        const current = downloadingRecord(key, { status, transferMode });
        harness.indexedDB.records.set(key, current);

        await harness.dispatch("backgroundfetchabort", {
            registration: backgroundFetchRegistration(key),
        });

        assert.deepEqual(harness.indexedDB.records.get(key), current);
        assert.deepEqual(harness.clientMessages, []);
    }
});

test("service worker serves a complete cached track and valid byte ranges from the stable virtual URL", async () => {
    const harness = createHarness();
    const audioCache = await harness.caches.open("soundspan-device-audio-v1");
    const audioUrl = `${ORIGIN}/__offline/audio/opaque-key`;
    const cachedAudio = new Response(
        Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
        {
            status: 200,
            headers: { "content-type": "audio/mpeg" },
        },
    );
    const cloneCachedAudio = cachedAudio.clone.bind(cachedAudio);
    let cachedArrayBufferCalls = 0;
    cachedAudio.clone = () => {
        const clone = cloneCachedAudio();
        clone.arrayBuffer = async () => {
            cachedArrayBufferCalls += 1;
            throw new Error("Range serving copied the full cache body");
        };
        return clone;
    };
    audioCache.values.set(audioUrl, cachedAudio);

    const full = await harness.dispatch("fetch", {
        request: new Request(`${ORIGIN}/__offline/audio/opaque-key`),
    });
    assert.ok(full);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(
        new Uint8Array(await full.arrayBuffer()),
        Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );

    const range = await harness.dispatch("fetch", {
        request: new Request(`${ORIGIN}/__offline/audio/opaque-key`, {
            headers: { range: "bytes=2-5" },
        }),
    });
    assert.ok(range);
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(range.headers.get("content-length"), "4");
    assert.equal(range.headers.get("accept-ranges"), "bytes");
    assert.equal(range.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual(
        new Uint8Array(await range.arrayBuffer()),
        Uint8Array.from([2, 3, 4, 5]),
    );
    assert.equal(cachedArrayBufferCalls, 0);
});

test("service worker answers invalid or multi-range requests with 416", async () => {
    const harness = createHarness();
    const audioCache = await harness.caches.open("soundspan-device-audio-v1");
    await audioCache.put(
        `${ORIGIN}/__offline/audio/opaque-key`,
        new Response(Uint8Array.from([0, 1, 2, 3])),
    );

    for (const rangeHeader of ["bytes=9-10", "bytes=0-1,3-4", "items=0-1"]) {
        const response = await harness.dispatch("fetch", {
            request: new Request(`${ORIGIN}/__offline/audio/opaque-key`, {
                headers: { range: rangeHeader },
            }),
        });
        assert.ok(response);
        assert.equal(response.status, 416, rangeHeader);
        assert.equal(response.headers.get("content-range"), "bytes */4");
    }
});

test("install rejects a failed Downloads document without replacing the previous shell cache", async () => {
    const harness = createHarness(async (request) => {
        const url = new URL(requestUrl(request));
        if (url.pathname === "/") {
            return new Response("<html>Root</html>", {
                headers: { "content-type": "text/html" },
            });
        }
        if (url.pathname === "/library") {
            return new Response("Unavailable", { status: 503 });
        }
        return new Response("optional", { status: 200 });
    });
    const previousCache = await harness.caches.open("soundspan-v2");
    await previousCache.put(`${ORIGIN}/`, new Response("previous shell"));

    await assert.rejects(
        harness.dispatch("install"),
        /важный офлайн-документ.*library/i,
    );

    assert.equal(
        await (await previousCache.match(`${ORIGIN}/`))?.text(),
        "previous shell",
    );
    assert.equal((await harness.caches.open("soundspan-v4")).values.size, 0);
});

test("install rejects a failed discovered Next chunk before publishing critical documents", async () => {
    const harness = createHarness(async (request) => {
        const url = new URL(requestUrl(request));
        if (url.pathname === "/") {
            return new Response(
                '<html><script src="/_next/static/root.js"></script></html>',
                { headers: { "content-type": "text/html" } },
            );
        }
        if (url.pathname === "/library") {
            return new Response(
                '<html><script src="/_next/static/downloads.js"></script></html>',
                { headers: { "content-type": "text/html" } },
            );
        }
        if (url.pathname === "/_next/static/downloads.js") {
            return new Response("Missing", { status: 404 });
        }
        return new Response("asset", { status: 200 });
    });
    const previousCache = await harness.caches.open("soundspan-v2");
    await previousCache.put(`${ORIGIN}/`, new Response("previous shell"));

    await assert.rejects(
        harness.dispatch("install"),
        /важный офлайн-ресурс.*downloads\.js/i,
    );

    assert.equal(
        await (await previousCache.match(`${ORIGIN}/`))?.text(),
        "previous shell",
    );
    assert.equal((await harness.caches.open("soundspan-v4")).values.size, 0);
});

test("successful install atomically caches both offline documents and their Next runtime chunks", async () => {
    const harness = createHarness(async (request) => {
        const url = new URL(requestUrl(request));
        if (url.pathname === "/") {
            return new Response(
                '<html><script src="/_next/static/root.js"></script></html>',
                { headers: { "content-type": "text/html" } },
            );
        }
        if (url.pathname === "/library") {
            return new Response(
                '<html><link href="/_next/static/downloads.css" rel="stylesheet"></html>',
                { headers: { "content-type": "text/html" } },
            );
        }
        if (url.pathname === "/runtime-config") {
            return new Response("window.__CONFIG__ = {};", {
                headers: { "content-type": "application/javascript" },
            });
        }
        if (url.pathname.startsWith("/_next/static/")) {
            return new Response(`asset:${url.pathname}`, { status: 200 });
        }
        return new Response("Optional unavailable", { status: 404 });
    });

    await harness.dispatch("install");

    const shellCache = await harness.caches.open("soundspan-v4");
    for (const path of [
        "/",
        "/library?tab=downloads",
        "/runtime-config",
        "/_next/static/root.js",
        "/_next/static/downloads.css",
    ]) {
        assert.ok(await shellCache.match(`${ORIGIN}${path}`), path);
    }
});

test("activate retires legacy Background Fetch, reloads an old client once, and preserves device audio", async () => {
    const harness = createHarness();
    await harness.caches.open("soundspan-v0");
    await harness.caches.open("soundspan-v2");
    await harness.caches.open("soundspan-v3");
    await harness.caches.open("soundspan-v4");
    await harness.caches.open("soundspan-device-audio-v1");
    await harness.caches.open("soundspan-device-audio-v1-future");
    const legacyId = "soundspan-device-audio-stuck::1";
    const foreignId = "another-app-download";
    harness.addLegacyBackgroundFetch(legacyId);
    harness.addLegacyBackgroundFetch(foreignId);

    await harness.dispatch("activate");

    assert.equal(harness.caches.stores.has("soundspan-v0"), false);
    assert.equal(harness.caches.stores.has("soundspan-v2"), false);
    assert.equal(harness.caches.stores.has("soundspan-v3"), false);
    assert.equal(harness.caches.stores.has("soundspan-v4"), true);
    assert.equal(harness.caches.stores.has("soundspan-device-audio-v1"), true);
    assert.equal(
        harness.caches.stores.has("soundspan-device-audio-v1-future"),
        true,
    );
    assert.equal(harness.hasLegacyBackgroundFetch(legacyId), false);
    assert.equal(harness.hasLegacyBackgroundFetch(foreignId), true);
    assert.deepEqual(harness.clientNavigations, [
        `${ORIGIN}/library?tab=downloads`,
    ]);
    assert.equal(harness.claimCalls, 1);
});

test("activate keeps open clients intact when no legacy shell migration is required", async () => {
    const harness = createHarness();
    await harness.caches.open("soundspan-v4");

    await harness.dispatch("activate");

    assert.deepEqual(harness.clientNavigations, []);
    assert.equal(harness.claimCalls, 1);
});

test("activate reloads a legacy Background Fetch client even after its shell cache was evicted", async () => {
    const harness = createHarness();
    await harness.caches.open("soundspan-v4");
    harness.addLegacyBackgroundFetch("soundspan-device-audio-stuck::2");

    await harness.dispatch("activate");

    assert.deepEqual(harness.clientNavigations, [
        `${ORIGIN}/library?tab=downloads`,
    ]);
});

test("one rejected client navigation does not block the remaining clients", async () => {
    const harness = createHarness(undefined, undefined, ["reject", "resolve"]);
    await harness.caches.open("soundspan-v3");
    await harness.caches.open("soundspan-v4");

    await harness.dispatch("activate");

    assert.deepEqual(harness.clientNavigations, [
        `${ORIGIN}/library?tab=downloads`,
        `${ORIGIN}/search?client=1`,
    ]);
    assert.equal(harness.claimCalls, 1);
});

test("an uncached route redirects to the cached homepage instead of serving it under the wrong URL", async () => {
    const harness = createHarness();
    const cache = await harness.caches.open("soundspan-v4");
    await cache.put(`${ORIGIN}/`, new Response("<html>Home only</html>"));
    const response = await harness.dispatch("fetch", {
        request: {
            method: "GET",
            mode: "navigate",
            url: `${ORIGIN}/library`,
            headers: new Headers(),
        },
    });
    assert.equal(response?.status, 302);
    assert.equal(response?.headers.get("Location"), `${ORIGIN}/`);
    assert.doesNotMatch(await response!.text(), /Home only/);
    const landing = await harness.dispatch("fetch", {
        request: {
            method: "GET",
            mode: "navigate",
            url: response!.headers.get("Location")!,
            headers: new Headers(),
        },
    });
    assert.equal(landing?.status, 200);
    assert.match(await landing!.text(), /Home only/);
});

test("cold offline navigation to Library Downloads returns its cached app shell", async () => {
    const harness = createHarness();
    const shellCache = await harness.caches.open("soundspan-v4");
    await shellCache.put(
        `${ORIGIN}/library?tab=downloads`,
        new Response("<html><body>Downloads shell</body></html>", {
            headers: { "content-type": "text/html" },
        }),
    );

    const response = await harness.dispatch("fetch", {
        request: {
            method: "GET",
            mode: "navigate",
            url: `${ORIGIN}/library?tab=downloads`,
            headers: new Headers(),
        },
    });

    assert.ok(response);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Downloads shell/);
});

test(
    "a stalled navigation times out into the cached app shell",
    { timeout: 500 },
    async () => {
        let timeoutDelayMs: number | undefined;
        const harness = createHarness(
            () => new Promise<Response>(() => undefined),
            {
                setTimeout: (callback, delayMs) => {
                    timeoutDelayMs = delayMs;
                    queueMicrotask(callback);
                    return Symbol("navigation-timeout");
                },
                clearTimeout: () => undefined,
            },
        );
        const shellCache = await harness.caches.open("soundspan-v4");
        await shellCache.put(
            `${ORIGIN}/library?tab=downloads`,
            new Response("<html><body>Timed fallback</body></html>"),
        );

        const response = await harness.dispatch("fetch", {
            request: {
                method: "GET",
                mode: "navigate",
                url: `${ORIGIN}/library?tab=downloads`,
                headers: new Headers(),
            },
        });

        assert.equal(timeoutDelayMs, 5_000);
        assert.ok(response);
        assert.match(await response.text(), /Timed fallback/);
    },
);

test("navigation retains the usable previous shell when a new build chunk fails", async () => {
    const harness = createHarness(async (request) => {
        if (new URL(request.url).pathname.startsWith("/_next/"))
            throw new TypeError("network changed");
        return new Response(
            '<html><script src="/_next/static/chunks/new.js"></script>New shell</html>',
            { headers: { "Content-Type": "text/html" } },
        );
    });
    const cache = await harness.caches.open("soundspan-v4");
    await cache.put(`${ORIGIN}/`, new Response("Usable previous shell"));
    const response = await harness.dispatch("fetch", {
        request: {
            method: "GET",
            mode: "navigate",
            url: `${ORIGIN}/`,
            headers: new Headers(),
        },
    });
    assert.equal(await response?.text(), "Usable previous shell");
    assert.equal(
        await (await cache.match(`${ORIGIN}/`))?.text(),
        "Usable previous shell",
    );
});

test("navigation publishes its bootstrap assets before exposing fresh HTML", async () => {
    let online = true;
    const fetched: string[] = [];
    const harness = createHarness(async (request) => {
        if (!online) throw new TypeError("offline");
        const path = new URL(request.url).pathname;
        fetched.push(path);
        return new Response(
            path === "/"
                ? '<html><link href="/_next/static/a.css" rel="stylesheet"><script src="/_next/static/a.js"></script><script src="/runtime-config"></script><img src="https://external.test/image.jpg">Fresh shell</html>'
                : `asset:${path}`,
        );
    });
    const response = await harness.dispatch("fetch", {
        request: {
            method: "GET",
            mode: "navigate",
            url: `${ORIGIN}/`,
            headers: new Headers(),
        },
    });
    assert.match(await response!.text(), /Fresh shell/);
    online = false;
    for (const path of [
        "/_next/static/a.js",
        "/_next/static/a.css",
        "/runtime-config",
    ]) {
        const cached = await harness.dispatch("fetch", {
            request: new Request(`${ORIGIN}${path}`),
        });
        assert.equal(await cached?.text(), `asset:${path}`);
    }
    assert.deepEqual(fetched.sort(), [
        "/",
        "/_next/static/a.css",
        "/_next/static/a.js",
        "/runtime-config",
    ]);
});

test(
    "a bootstrap asset with a stalled body cannot trap navigation indefinitely",
    { timeout: 500 },
    async () => {
        const harness = createHarness(
            async (request) =>
                new URL(request.url).pathname === "/"
                    ? new Response(
                          '<script src="/_next/static/hanging.js"></script>',
                      )
                    : new Response(new ReadableStream()),
            {
                setTimeout: (callback) => setTimeout(callback, 20),
                clearTimeout: (handle) =>
                    clearTimeout(handle as ReturnType<typeof setTimeout>),
            },
        );
        const cache = await harness.caches.open("soundspan-v4");
        await cache.put(`${ORIGIN}/`, new Response("Previous shell"));
        const response = await harness.dispatch("fetch", {
            request: {
                method: "GET",
                mode: "navigate",
                url: `${ORIGIN}/`,
                headers: new Headers(),
            },
        });
        assert.equal(await response?.text(), "Previous shell");
    },
);

test("offline bootstrap uses cached configuration and document without starting network", async () => {
    let calls = 0;
    const harness = createHarness(async () => {
        calls += 1;
        throw new TypeError("offline");
    });
    harness.navigator.onLine = false;
    const cache = await harness.caches.open("soundspan-v4");
    for (const path of ["/runtime-config", "/library?tab=downloads"]) {
        await cache.put(`${ORIGIN}${path}`, new Response(`cached:${path}`));
        const response = await harness.dispatch("fetch", {
            request: {
                method: "GET",
                mode: path === "/runtime-config" ? "no-cors" : "navigate",
                url: `${ORIGIN}${path}`,
                headers: new Headers(),
            },
        });
        assert.equal(await response?.text(), `cached:${path}`);
    }
    assert.equal(calls, 0);
});

test(
    "stalled bootstrap configuration falls back within its deadline",
    { timeout: 500 },
    async () => {
        let deadline: number | undefined;
        const harness = createHarness(
            () => new Promise<Response>(() => undefined),
            {
                setTimeout: (callback, delay) => {
                    deadline = delay;
                    queueMicrotask(callback);
                    return 1;
                },
                clearTimeout: () => undefined,
            },
        );
        const cache = await harness.caches.open("soundspan-v4");
        await cache.put(
            `${ORIGIN}/runtime-config`,
            new Response("cached-config"),
        );
        const response = await harness.dispatch("fetch", {
            request: new Request(`${ORIGIN}/runtime-config`),
        });
        assert.equal(await response?.text(), "cached-config");
        assert.ok(deadline !== undefined && deadline <= 1500);
    },
);

test("online bootstrap configuration refreshes the cached value", async () => {
    const harness = createHarness(async () => new Response("fresh-config"));
    const cache = await harness.caches.open("soundspan-v4");
    await cache.put(`${ORIGIN}/runtime-config`, new Response("old-config"));
    const response = await harness.dispatch("fetch", {
        request: new Request(`${ORIGIN}/runtime-config`),
    });
    assert.equal(await response?.text(), "fresh-config");
    assert.equal(
        await (await cache.match(`${ORIGIN}/runtime-config`))?.text(),
        "fresh-config",
    );
});

test(
    "bootstrap deadline also bounds a response whose headers arrive but body stalls",
    { timeout: 500 },
    async () => {
        const harness = createHarness(
            async () => new Response(new ReadableStream()),
            {
                setTimeout: (callback) => setTimeout(callback, 10),
                clearTimeout: (handle) =>
                    clearTimeout(handle as ReturnType<typeof setTimeout>),
            },
        );
        const cache = await harness.caches.open("soundspan-v4");
        await cache.put(
            `${ORIGIN}/runtime-config`,
            new Response("complete-config"),
        );
        const response = await harness.dispatch("fetch", {
            request: new Request(`${ORIGIN}/runtime-config`),
        });
        assert.equal(await response?.text(), "complete-config");
    },
);

test("Next route-transition requests remain outside the service worker response path", async () => {
    const harness = createHarness(async () => new Response("unexpected"));
    const response = await harness.dispatch("fetch", {
        request: {
            method: "GET",
            mode: "cors",
            url: `${ORIGIN}/library`,
            headers: new Headers({
                RSC: "1",
                "Next-Router-State-Tree": "tree",
            }),
        },
    });

    assert.equal(response, undefined);
});

test("cover art still uses its stable token-free cache key", async () => {
    let networkCalls = 0;
    const harness = createHarness(async () => {
        networkCalls += 1;
        return new Response("network");
    });
    const imageCache = await harness.caches.open("soundspan-images-v3");
    await imageCache.put(
        `${ORIGIN}/api/library/cover-art/album?size=320`,
        new Response("cached-image"),
    );

    const response = await harness.dispatch("fetch", {
        request: new Request(
            `${ORIGIN}/api/library/cover-art/album?size=320&token=legacy.jwt.signature`,
        ),
    });

    assert.ok(response);
    assert.equal(await response.text(), "cached-image");
    assert.equal(networkCalls, 0);
});

test("waiting service-worker update activates only after an explicit message", async () => {
    const harness = createHarness();

    await harness.dispatch("message", { data: { type: "UNRELATED" } });
    assert.equal(harness.skipWaitingCalls, 0);

    await harness.dispatch("message", { data: { type: "SKIP_WAITING" } });
    assert.equal(harness.skipWaitingCalls, 1);
});

test("service worker advertises the device-offline background protocol", async () => {
    const harness = createHarness();
    const responses: unknown[] = [];

    await harness.dispatch("message", {
        data: { type: "DEVICE_OFFLINE_CAPABILITIES_REQUEST" },
        ports: [
            {
                postMessage(value: unknown) {
                    responses.push(structuredClone(value));
                },
            },
        ],
    });

    assert.deepEqual(responses, [
        {
            type: "DEVICE_OFFLINE_CAPABILITIES",
            backgroundFetchProtocol: 0,
        },
    ]);
});
