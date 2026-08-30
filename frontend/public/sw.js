// soundspan Service Worker
const CACHE_NAME = "soundspan-v4";
const IMAGE_CACHE_NAME = "soundspan-images-v3";
const IMAGE_METADATA_CACHE_NAME = "soundspan-images-metadata-v2";
const DEVICE_AUDIO_CACHE_NAME = "soundspan-device-audio-v1";
const DEVICE_AUDIO_CACHE_PREFIX = "soundspan-device-audio-v1";
const DEVICE_AUDIO_PATH_PREFIX = "/__offline/audio/";
const DEVICE_AUDIO_TEMP_PATH_PREFIX = "/__offline/audio-temp/";
const DEVICE_OFFLINE_DATABASE_NAME = "soundspan-device-offline-v1";
const DEVICE_OFFLINE_STORE_NAME = "downloads";
const BACKGROUND_FETCH_ID_PREFIX = "soundspan-device-audio-";
// Protocol 0 explicitly retires new Background Fetch starts. Activation also
// navigates every already-open client once so an older bundle cannot recreate
// the retired protocol after the worker's initial cleanup sweep.
const DEVICE_OFFLINE_BACKGROUND_FETCH_PROTOCOL = 0;
const BACKGROUND_COMPLETION_LEASE_TTL_MS = 5 * 60 * 1000;
const MAX_IMAGE_CACHE_ENTRIES = 2000;
const MAX_CONCURRENT_IMAGE_REQUESTS = 4;
const REQUEST_DELAY_MS = 10;
const IMAGE_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const NAVIGATION_NETWORK_TIMEOUT_MS = 5_000;
const LEGACY_BACKGROUND_OPERATION_TIMEOUT_MS = 3_000;

const CRITICAL_PRECACHE_DOCUMENTS = ["/", "/library?tab=downloads"];
const CRITICAL_PRECACHE_ASSETS = ["/runtime-config"];
const OPTIONAL_PRECACHE_ASSETS = [
    "/manifest.webmanifest",
    "/assets/images/soundspan.webp",
];
const IMAGE_PATTERNS = [
    /^\/api\/library\/cover-art/,
    /^\/api\/audiobooks\/.*\/cover/,
    /^\/api\/podcasts\/.*\/cover/,
];

let activeImageRequests = 0;
const imageRequestQueue = [];

function settleOperationWithin(operation, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ state: "timeout" });
        }, timeoutMs);
        Promise.resolve(operation).then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ state: "resolved", value });
            },
            () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ state: "rejected" });
            },
        );
    });
}

async function retireLegacyBackgroundFetches() {
    const manager = self.registration?.backgroundFetch;
    if (!manager?.getIds || !manager?.get) return false;
    const idsResult = await settleOperationWithin(
        manager.getIds(),
        LEGACY_BACKGROUND_OPERATION_TIMEOUT_MS,
    );
    if (idsResult.state !== "resolved" || !Array.isArray(idsResult.value)) {
        return false;
    }
    const ids = idsResult.value.filter(
        (id) =>
            typeof id === "string" && id.startsWith(BACKGROUND_FETCH_ID_PREFIX),
    );
    const results = await Promise.all(
        ids.map(async (id) => {
            const lookup = await settleOperationWithin(
                manager.get(id),
                LEGACY_BACKGROUND_OPERATION_TIMEOUT_MS,
            );
            if (lookup.state !== "resolved") return false;
            const registration = lookup.value;
            if (!registration) return true;
            if (typeof registration.abort !== "function") return false;
            const aborted = await settleOperationWithin(
                registration.abort(),
                LEGACY_BACKGROUND_OPERATION_TIMEOUT_MS,
            );
            return aborted.state === "resolved" && aborted.value !== false;
        }),
    );
    return results.every(Boolean);
}

function isImageRoute(pathname) {
    return IMAGE_PATTERNS.some((pattern) => pattern.test(pathname));
}

function getImageCacheKey(request, url) {
    if (!url.searchParams.has("token")) return request;
    const keyUrl = new URL(url.toString());
    keyUrl.searchParams.delete("token");
    return new Request(keyUrl.toString(), { headers: request.headers });
}

async function trimCache(cacheName, maxEntries) {
    const cache = await caches.open(cacheName);
    const metadataCache = await caches.open(IMAGE_METADATA_CACHE_NAME);
    const keys = await cache.keys();
    for (let index = 0; index < keys.length - maxEntries; index++) {
        await cache.delete(keys[index]);
        await metadataCache.delete(keys[index]);
    }
}

async function setImageCachedAt(request) {
    const cache = await caches.open(IMAGE_METADATA_CACHE_NAME);
    await cache.put(request, new Response(String(Date.now())));
}

async function getImageCachedAt(request) {
    const cache = await caches.open(IMAGE_METADATA_CACHE_NAME);
    const response = await cache.match(request);
    if (!response) return null;
    const cachedAt = Number(await response.text());
    if (!Number.isFinite(cachedAt)) {
        await cache.delete(request);
        return null;
    }
    return cachedAt;
}

async function isImageCacheEntryFresh(request) {
    const cachedAt = await getImageCachedAt(request);
    if (cachedAt === null) {
        await setImageCachedAt(request);
        return true;
    }
    return Date.now() - cachedAt <= IMAGE_CACHE_TTL_MS;
}

function processImageQueue() {
    while (
        activeImageRequests < MAX_CONCURRENT_IMAGE_REQUESTS &&
        imageRequestQueue.length > 0
    ) {
        const { request, cacheKey, resolve, reject } =
            imageRequestQueue.shift();
        activeImageRequests++;
        fetchAndCacheImage(request, cacheKey)
            .then(resolve)
            .catch(reject)
            .finally(() => {
                activeImageRequests--;
                setTimeout(processImageQueue, REQUEST_DELAY_MS);
            });
    }
}

async function fetchAndCacheImage(request, cacheKey) {
    const cache = await caches.open(IMAGE_CACHE_NAME);
    try {
        const response = await fetch(request);
        if (response.status === 200) {
            cache.put(cacheKey, response.clone());
            setImageCachedAt(cacheKey);
            trimCache(IMAGE_CACHE_NAME, MAX_IMAGE_CACHE_ENTRIES);
        }
        return response;
    } catch {
        return new Response("Изображение недоступно", { status: 503 });
    }
}

function queueImageRequest(request, cacheKey) {
    return new Promise((resolve, reject) => {
        imageRequestQueue.push({ request, cacheKey, resolve, reject });
        processImageQueue();
    });
}

async function fetchNavigationWithTimeout(request) {
    const controller = new AbortController();
    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
            controller.abort();
            reject(
                new Error("Истекло время ожидания сетевого запроса навигации"),
            );
        }, NAVIGATION_NETWORK_TIMEOUT_MS);
    });
    try {
        return await Promise.race([
            fetch(request, { signal: controller.signal }),
            timeout,
        ]);
    } finally {
        clearTimeout(timeoutHandle);
    }
}

function parseSingleByteRange(value, size) {
    if (!value || size < 0 || value.includes(",")) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
    if (!match || (!match[1] && !match[2])) return null;

    let start;
    let end;
    if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
            return null;
        }
        start = Math.max(0, size - suffixLength);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
    }
    if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        start >= size
    ) {
        return null;
    }
    return { start, end: Math.min(end, size - 1) };
}

async function serveDeviceAudio(request, url) {
    const cache = await caches.open(DEVICE_AUDIO_CACHE_NAME);
    const cached = await cache.match(url.toString());
    if (!cached) {
        return new Response("Аудиофайл на устройстве недоступен", {
            status: 404,
        });
    }

    const rangeHeader = request.headers.get("range");
    if (!rangeHeader) {
        const headers = new Headers(cached.headers);
        headers.set("accept-ranges", "bytes");
        return new Response(request.method === "HEAD" ? null : cached.body, {
            status: cached.status,
            statusText: cached.statusText,
            headers,
        });
    }

    const cachedBlob = await cached.blob();
    const range = parseSingleByteRange(rangeHeader, cachedBlob.size);
    if (!range) {
        return new Response(null, {
            status: 416,
            headers: {
                "accept-ranges": "bytes",
                "content-range": `bytes */${cachedBlob.size}`,
            },
        });
    }

    const body = cachedBlob.slice(range.start, range.end + 1);
    const headers = new Headers(cached.headers);
    headers.set("accept-ranges", "bytes");
    headers.set(
        "content-range",
        `bytes ${range.start}-${range.end}/${cachedBlob.size}`,
    );
    headers.set("content-length", String(body.size));
    return new Response(request.method === "HEAD" ? null : body, {
        status: 206,
        headers,
    });
}

function openDeviceOfflineDatabase() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
            reject(new Error("IndexedDB недоступна"));
            return;
        }
        const request = indexedDB.open(DEVICE_OFFLINE_DATABASE_NAME);
        request.onupgradeneeded = () => {
            if (
                !request.result.objectStoreNames.contains(
                    DEVICE_OFFLINE_STORE_NAME,
                )
            ) {
                request.result.createObjectStore(DEVICE_OFFLINE_STORE_NAME, {
                    keyPath: "key",
                });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
            reject(request.error ?? new Error("Не удалось открыть IndexedDB"));
    });
}

async function mutateDeviceOfflineRecord(key, mutate) {
    const database = await openDeviceOfflineDatabase();
    try {
        return await new Promise((resolve, reject) => {
            let found = false;
            const transaction = database.transaction(
                DEVICE_OFFLINE_STORE_NAME,
                "readwrite",
            );
            const store = transaction.objectStore(DEVICE_OFFLINE_STORE_NAME);
            const request = store.get(key);
            request.onsuccess = () => {
                if (request.result) {
                    const next = mutate(request.result);
                    if (next) {
                        found = true;
                        store.put(next);
                    }
                }
            };
            request.onerror = () => transaction.abort();
            transaction.oncomplete = () => resolve(found);
            transaction.onerror = () =>
                reject(
                    transaction.error ??
                        new Error("Не удалось обновить загрузку на устройство"),
                );
            transaction.onabort = () =>
                reject(
                    transaction.error ??
                        new Error(
                            "Обновление загрузки на устройство было отменено",
                        ),
                );
        });
    } finally {
        database.close();
    }
}

async function getDeviceOfflineRecord(key) {
    const database = await openDeviceOfflineDatabase();
    try {
        return await new Promise((resolve, reject) => {
            let record = null;
            const transaction = database.transaction(
                DEVICE_OFFLINE_STORE_NAME,
                "readonly",
            );
            const request = transaction
                .objectStore(DEVICE_OFFLINE_STORE_NAME)
                .get(key);
            request.onsuccess = () => {
                record = request.result ?? null;
            };
            request.onerror = () => transaction.abort();
            transaction.oncomplete = () => resolve(record);
            transaction.onerror = () =>
                reject(
                    transaction.error ??
                        new Error(
                            "Не удалось прочитать загрузку на устройство",
                        ),
                );
            transaction.onabort = () =>
                reject(
                    transaction.error ??
                        new Error(
                            "Чтение загрузки на устройство было отменено",
                        ),
                );
        });
    } finally {
        database.close();
    }
}

async function notifyDeviceOfflineClients(key, status) {
    const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
    });
    for (const client of clients) {
        client.postMessage({ type: "DEVICE_OFFLINE_CHANGED", key, status });
    }
}

function backgroundFetchIdentity(registration) {
    const id = registration?.id;
    if (typeof id !== "string" || !id.startsWith(BACKGROUND_FETCH_ID_PREFIX)) {
        return null;
    }
    const suffix = id.slice(BACKGROUND_FETCH_ID_PREFIX.length);
    const attemptSeparator = suffix.lastIndexOf("::");
    const encodedKey =
        attemptSeparator >= 0 ? suffix.slice(0, attemptSeparator) : suffix;
    if (!encodedKey) return null;
    try {
        return { id, key: decodeURIComponent(encodedKey) };
    } catch {
        return null;
    }
}

function isCurrentBackgroundFetch(record, registrationId) {
    return (
        record?.status === "downloading" &&
        record.transferMode === "background" &&
        record.backgroundFetchId === registrationId
    );
}

async function markBackgroundFetchInterrupted(registration, code, message) {
    const identity = backgroundFetchIdentity(registration);
    if (!identity) return;
    const updated = await mutateDeviceOfflineRecord(identity.key, (record) =>
        isCurrentBackgroundFetch(record, identity.id)
            ? {
                  ...record,
                  status: "interrupted",
                  backgroundFetchId: null,
                  foregroundLeaseId: null,
                  foregroundLeaseExpiresAt: null,
                  updatedAt: Date.now(),
                  errorCode: code,
                  errorMessage: message,
              }
            : null,
    );
    if (updated) await notifyDeviceOfflineClients(identity.key, "interrupted");
}

async function handleBackgroundFetchSuccess(registration) {
    const identity = backgroundFetchIdentity(registration);
    if (!identity) return "ignored";
    const completionLeaseId = `background-completing:${identity.id}`;
    const completionClaimed = await mutateDeviceOfflineRecord(
        identity.key,
        (record) =>
            isCurrentBackgroundFetch(record, identity.id)
                ? {
                      ...record,
                      foregroundLeaseId: completionLeaseId,
                      foregroundLeaseExpiresAt:
                          Date.now() + BACKGROUND_COMPLETION_LEASE_TTL_MS,
                      updatedAt: Date.now(),
                  }
                : null,
    );
    if (!completionClaimed) return "ignored";
    const records = await registration.matchAll();
    if (records.length !== 1) {
        throw new Error("Ожидался один ответ фоновой загрузки аудио");
    }
    const response = await records[0].responseReady;
    if (!response || response.status !== 200) {
        throw new Error(
            `Не удалось скачать аудио в фоне: HTTP ${response?.status ?? 0}`,
        );
    }

    const virtualUrl = new URL(
        `${DEVICE_AUDIO_PATH_PREFIX}${encodeURIComponent(identity.key)}`,
        self.location.origin,
    ).toString();
    const temporaryUrl = new URL(
        `${DEVICE_AUDIO_TEMP_PATH_PREFIX}${encodeURIComponent(identity.id)}`,
        self.location.origin,
    ).toString();
    const headers = new Headers(response.headers);
    headers.set("accept-ranges", "bytes");
    const cache = await caches.open(DEVICE_AUDIO_CACHE_NAME);
    await cache.put(
        temporaryUrl,
        new Response(response.body, { status: 200, headers }),
    );
    const retained = await cache.match(temporaryUrl);
    if (!retained) throw new Error("Загруженный аудиофайл не был сохранён");

    const rawContentLength = retained.headers.get("content-length");
    const contentLength =
        rawContentLength === null || rawContentLength.trim() === ""
            ? Number.NaN
            : Number(rawContentLength);
    const declaredTotalBytes =
        Number.isSafeInteger(contentLength) && contentLength >= 0
            ? contentLength
            : null;
    const actualTotalBytes = (await retained.clone().arrayBuffer()).byteLength;
    if (actualTotalBytes < 1) {
        throw new Error("Ответ завершённой фоновой загрузки аудио пуст");
    }
    if (
        declaredTotalBytes !== null &&
        declaredTotalBytes !== actualTotalBytes
    ) {
        throw new Error(
            `Размер аудио после фоновой загрузки не совпадает (${actualTotalBytes} из ${declaredTotalBytes} байт)`,
        );
    }
    const totalBytes = actualTotalBytes;
    const latest = await getDeviceOfflineRecord(identity.key);
    if (!isCurrentBackgroundFetch(latest, identity.id)) {
        await cache.delete(temporaryUrl);
        return "ignored";
    }
    await cache.put(virtualUrl, retained.clone());
    const published = await cache.match(virtualUrl);
    if (!published) throw new Error("Загруженный аудиофайл не был опубликован");
    const publishedBytes = (await published.arrayBuffer()).byteLength;
    if (publishedBytes !== totalBytes) {
        throw new Error(
            `Размер опубликованного аудио не совпадает (${publishedBytes} из ${totalBytes} байт)`,
        );
    }
    const updated = await mutateDeviceOfflineRecord(identity.key, (record) =>
        isCurrentBackgroundFetch(record, identity.id)
            ? {
                  ...record,
                  status: "ready",
                  transferMode: "background",
                  backgroundFetchId: null,
                  foregroundLeaseId: null,
                  foregroundLeaseExpiresAt: null,
                  bytesReceived: totalBytes ?? record.bytesReceived,
                  totalBytes: totalBytes ?? record.totalBytes,
                  integrityVersion: 1,
                  contentType: retained.headers.get("content-type"),
                  updatedAt: Date.now(),
                  errorCode: null,
                  errorMessage: null,
              }
            : null,
    );
    await cache.delete(temporaryUrl);
    if (!updated) {
        const currentAfterPublish = await getDeviceOfflineRecord(identity.key);
        if (
            !currentAfterPublish ||
            isCurrentBackgroundFetch(currentAfterPublish, identity.id)
        ) {
            await cache.delete(virtualUrl);
        }
        return "ignored";
    }
    await notifyDeviceOfflineClients(identity.key, "ready");
    return "saved";
}

async function handleBackgroundFetchSuccessSafely(registration) {
    try {
        return await handleBackgroundFetchSuccess(registration);
    } catch (error) {
        const identity = backgroundFetchIdentity(registration);
        if (identity) {
            try {
                const cache = await caches.open(DEVICE_AUDIO_CACHE_NAME);
                await cache.delete(
                    new URL(
                        `${DEVICE_AUDIO_TEMP_PATH_PREFIX}${encodeURIComponent(identity.id)}`,
                        self.location.origin,
                    ).toString(),
                );
                const current = await getDeviceOfflineRecord(
                    identity.key,
                ).catch(() => null);
                if (
                    !current ||
                    isCurrentBackgroundFetch(current, identity.id)
                ) {
                    await cache.delete(
                        new URL(
                            `${DEVICE_AUDIO_PATH_PREFIX}${encodeURIComponent(identity.key)}`,
                            self.location.origin,
                        ).toString(),
                    );
                }
            } catch {
                // Cleanup is best-effort; the retryable metadata transition is
                // the safety boundary that prevents a partial copy playing.
            }
        }
        await markBackgroundFetchInterrupted(
            registration,
            "background_failed",
            error instanceof Error
                ? error.message
                : "Не удалось сохранить фоновую загрузку",
        ).catch(() => undefined);
        return "failed";
    }
}

self.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE_NAME);
            const discoveredAssets = new Set();
            const criticalDocuments = await Promise.all(
                CRITICAL_PRECACHE_DOCUMENTS.map(async (asset) => {
                    const url = new URL(asset, self.location.origin).toString();
                    const response = await fetch(
                        new Request(url, { cache: "reload" }),
                    );
                    if (!response.ok) {
                        throw new Error(
                            `Не удалось загрузить важный офлайн-документ: HTTP ${response.status}: ${asset}`,
                        );
                    }
                    const html = await response.clone().text();
                    for (const match of html.matchAll(
                        /(?:src|href)=["']([^"']+)["']/g,
                    )) {
                        const discovered = new URL(
                            match[1],
                            self.location.origin,
                        );
                        if (
                            discovered.origin === self.location.origin &&
                            discovered.pathname.startsWith("/_next/")
                        ) {
                            discoveredAssets.add(discovered.toString());
                        }
                    }
                    return { url, response };
                }),
            );

            const criticalAssets = await Promise.all(
                [
                    ...CRITICAL_PRECACHE_ASSETS.map((asset) =>
                        new URL(asset, self.location.origin).toString(),
                    ),
                    ...discoveredAssets,
                ].map(async (url) => {
                    const response = await fetch(
                        new Request(url, { cache: "reload" }),
                    );
                    if (!response.ok) {
                        throw new Error(
                            `Не удалось загрузить важный офлайн-ресурс: HTTP ${response.status}: ${url}`,
                        );
                    }
                    return { url, response };
                }),
            );

            await Promise.all(
                [...criticalDocuments, ...criticalAssets].map(
                    ({ url, response }) => cache.put(url, response),
                ),
            );

            await Promise.allSettled(
                OPTIONAL_PRECACHE_ASSETS.map(async (asset) => {
                    const url = new URL(asset, self.location.origin).toString();
                    const response = await fetch(
                        new Request(url, { cache: "reload" }),
                    );
                    if (response.ok) await cache.put(url, response);
                }),
            );
        })(),
    );
});

self.addEventListener("message", (event) => {
    if (event.data?.type === "DEVICE_OFFLINE_CAPABILITIES_REQUEST") {
        event.ports?.[0]?.postMessage({
            type: "DEVICE_OFFLINE_CAPABILITIES",
            backgroundFetchProtocol: DEVICE_OFFLINE_BACKGROUND_FETCH_PROTOCOL,
        });
        return;
    }
    if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            const cacheNames = await caches.keys();
            await retireLegacyBackgroundFetches().catch(() => false);
            await Promise.all(
                cacheNames
                    .filter(
                        (name) =>
                            name !== CACHE_NAME &&
                            name !== IMAGE_CACHE_NAME &&
                            name !== IMAGE_METADATA_CACHE_NAME &&
                            !name.startsWith(DEVICE_AUDIO_CACHE_PREFIX),
                    )
                    .map((name) => caches.delete(name)),
            );
            await self.clients.claim();
            // Activation is the only reliable migration barrier for already
            // open clients: an old shell cache or Background Fetch ID may have
            // been evicted before this worker can inspect it. Navigating every
            // window client exactly once per worker activation prevents an old
            // JavaScript bundle from recreating the retired transfer protocol.
            const windowClients = await self.clients.matchAll({
                type: "window",
                includeUncontrolled: true,
            });
            await Promise.allSettled(
                windowClients.map((client) =>
                    typeof client.navigate === "function" && client.url
                        ? client.navigate(client.url)
                        : Promise.resolve(),
                ),
            );
        })(),
    );
});

self.addEventListener("backgroundfetchsuccess", (event) => {
    event.waitUntil(
        (async () => {
            const outcome = await handleBackgroundFetchSuccessSafely(
                event.registration,
            );
            await event.updateUI?.({
                title:
                    outcome === "saved"
                        ? "Загрузка сохранена"
                        : "Загрузка остановлена",
            });
        })(),
    );
});
self.addEventListener("backgroundfetchfail", (event) => {
    event.waitUntil(
        (async () => {
            await markBackgroundFetchInterrupted(
                event.registration,
                "background_failed",
                "Фоновая загрузка браузера завершилась ошибкой. Возобновите её, чтобы повторить попытку.",
            ).catch(() => undefined);
            await event.updateUI?.({ title: "Загрузка остановлена" });
        })(),
    );
});
self.addEventListener("backgroundfetchabort", (event) => {
    event.waitUntil(
        (async () => {
            await markBackgroundFetchInterrupted(
                event.registration,
                "interrupted",
                "Фоновая загрузка была прервана. Возобновите её, чтобы повторить попытку.",
            ).catch(() => undefined);
            await event.updateUI?.({ title: "Загрузка остановлена" });
        })(),
    );
});

self.addEventListener("fetch", (event) => {
    const { request } = event;
    const url = new URL(request.url);
    if (!url.protocol.startsWith("http")) return;

    if (
        url.origin === self.location.origin &&
        url.pathname.startsWith(DEVICE_AUDIO_PATH_PREFIX) &&
        (request.method === "GET" || request.method === "HEAD")
    ) {
        event.respondWith(serveDeviceAudio(request, url));
        return;
    }
    if (request.method !== "GET") return;

    const isNextRouteRequest =
        request.headers.get("RSC") === "1" ||
        request.headers.has("Next-Router-State-Tree") ||
        request.headers.has("Next-Url") ||
        request.headers.has("Next-Router-Prefetch");
    if (isNextRouteRequest) return;
    if (url.pathname.includes("/stream")) return;
    if (url.pathname.startsWith("/_next/image")) return;

    if (isImageRoute(url.pathname)) {
        event.respondWith(
            (async () => {
                const cache = await caches.open(IMAGE_CACHE_NAME);
                const metadataCache = await caches.open(
                    IMAGE_METADATA_CACHE_NAME,
                );
                const cacheKey = getImageCacheKey(request, url);
                const cached = await cache.match(cacheKey, {
                    ignoreVary: true,
                });
                if (cached) {
                    if (await isImageCacheEntryFresh(cacheKey)) return cached;
                    await cache.delete(cacheKey, { ignoreVary: true });
                    await metadataCache.delete(cacheKey, { ignoreVary: true });
                }
                return queueImageRequest(request, cacheKey);
            })(),
        );
        return;
    }
    if (url.pathname.startsWith("/api/")) return;

    if (url.pathname.startsWith("/_next/")) {
        event.respondWith(
            caches.match(request).then((cached) => cached ?? fetch(request)),
        );
        return;
    }

    event.respondWith(
        (async () => {
            try {
                const response =
                    request.mode === "navigate"
                        ? await fetchNavigationWithTimeout(request)
                        : await fetch(request);
                if (response.status === 200) {
                    const cache = await caches.open(CACHE_NAME);
                    await cache.put(request, response.clone());
                }
                return response;
            } catch {
                const cache = await caches.open(CACHE_NAME);
                const exact = await cache.match(request);
                if (exact) return exact;
                if (request.mode === "navigate") {
                    const root = await cache.match(
                        new URL("/", self.location.origin).toString(),
                    );
                    if (root) return root;
                }
                return new Response("Нет подключения к интернету", {
                    status: 503,
                });
            }
        })(),
    );
});
