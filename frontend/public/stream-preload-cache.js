// Ephemeral completed-byte reuse for one native preload per controlled client.
// No CacheStorage, extra fetch, tee, or eager drain: the media consumer drives pull.
self.createCompletedStreamPreloadCache = function ({
    origin,
    parseRange,
    fetch: fetchRequest,
    now = () => Date.now(),
    maxCaptureBytes = 16 * 1024 * 1024,
    maxTotalBytes = 64 * 1024 * 1024,
    ttlMs = 120_000,
}) {
    const owners = new Map();
    let reservedBytes = 0;
    const expectedOrigin = new URL(origin).origin;
    const route = /^\/api\/ytmusic\/stream-public\/[A-Za-z0-9_-]{11}$/;
    const capability =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:\d+$/i;
    const audioTypes = new Set([
        "audio/webm",
        "video/webm",
        "audio/mp4",
        "audio/mpeg",
        "audio/ogg",
        "audio/opus",
        "audio/flac",
        "audio/x-flac",
        "audio/aac",
        "audio/wav",
        "audio/x-wav",
    ]);
    if (
        typeof parseRange !== "function" ||
        typeof fetchRequest !== "function" ||
        typeof now !== "function" ||
        ![maxCaptureBytes, maxTotalBytes, ttlMs].every(
            (value) => Number.isSafeInteger(value) && value > 0,
        )
    )
        throw new TypeError("Invalid completed preload cache options");

    function release(entry) {
        if (!entry || !entry.active) return;
        entry.active = false;
        reservedBytes -= entry.reserved;
        entry.reserved = 0;
        entry.chunks = [];
        entry.blob = null;
        entry.removeAbortListener?.();
    }

    function prune() {
        const time = now();
        for (const [clientId, owner] of owners) {
            if (owner.entry?.expiresAt <= time) {
                release(owner.entry);
                owner.entry = null;
            }
            if (owner.expiresAt <= time) {
                release(owner.entry);
                owners.delete(clientId);
            }
        }
    }

    function scope(request, clientId) {
        if (
            typeof clientId !== "string" ||
            !clientId ||
            request.method !== "GET"
        )
            return null;
        const url = new URL(request.url);
        const session = url.searchParams.get("preloadSession");
        const purpose = url.searchParams.get("purpose");
        if (
            url.origin !== expectedOrigin ||
            !route.test(url.pathname) ||
            url.searchParams.getAll("preloadSession").length !== 1 ||
            !session ||
            !capability.test(session) ||
            !Number.isSafeInteger(Number(session.split(":")[1])) ||
            url.searchParams.getAll("purpose").length > 1 ||
            (purpose !== null &&
                purpose !== "preload" &&
                purpose !== "interactive")
        )
            return null;
        if (purpose === "preload") url.searchParams.delete("purpose");
        // Only complete original YouTube responses enter this cache. Redirected
        // fallback leases are excluded by captureLength and carry no-store.
        url.searchParams.delete("playbackSession");
        // Apply identical encoding on both paths (e.g. raw ':' vs '%3A').
        url.search = url.searchParams.toString();
        return { session, key: url.toString(), preload: purpose === "preload" };
    }

    function captureLength(response) {
        const rawLength = response.headers.get("content-length");
        const length =
            rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : 0;
        const type = (response.headers.get("content-type") ?? "")
            .split(";")[0]
            .trim()
            .toLowerCase();
        const encoding = response.headers.get("content-encoding");
        const directives = (response.headers.get("cache-control") ?? "")
            .toLowerCase()
            .split(",")
            .map((part) => part.trim().split("=")[0]);
        if (
            !response.body ||
            response.redirected ||
            response.type === "opaque" ||
            !audioTypes.has(type) ||
            (encoding && encoding.toLowerCase() !== "identity") ||
            directives.includes("no-store") ||
            directives.includes("no-cache") ||
            !Number.isSafeInteger(length) ||
            length < 1 ||
            length > maxCaptureBytes
        )
            return null;
        if (response.status === 200 && !response.headers.has("content-range"))
            return length;
        if (response.status !== 206) return null;
        const range = /^bytes 0-(\d+)\/(\d+)$/.exec(
            response.headers.get("content-range") ?? "",
        );
        return range &&
            Number(range[1]) === length - 1 &&
            Number(range[2]) === length
            ? length
            : null;
    }

    function serve(request, entry) {
        const headers = new Headers(entry.headers);
        headers.delete("content-range");
        headers.set("accept-ranges", "bytes");
        headers.set("content-length", String(entry.blob.size));
        const rangeValue = request.headers.get("range");
        if (!rangeValue)
            return new Response(entry.blob, { status: 200, headers });
        const range = parseRange(rangeValue, entry.blob.size);
        if (!range)
            return new Response(null, {
                status: 416,
                headers: {
                    "accept-ranges": "bytes",
                    "content-range": `bytes */${entry.blob.size}`,
                },
            });
        const blob = entry.blob.slice(range.start, range.end + 1);
        headers.set("content-length", String(blob.size));
        headers.set(
            "content-range",
            `bytes ${range.start}-${range.end}/${entry.blob.size}`,
        );
        return new Response(blob, { status: 206, headers });
    }

    return {
        clearClient(clientId) {
            const owner = owners.get(clientId);
            release(owner?.entry);
            owners.delete(clientId);
        },
        async handle(request, clientId) {
            prune();
            const selected = scope(request, clientId);
            if (!selected) return fetchRequest(request);
            if (request.signal.aborted) throw request.signal.reason;
            let owner = owners.get(clientId);
            if (
                owner &&
                owner.session.split(":")[0] ===
                    selected.session.split(":")[0] &&
                Number(selected.session.split(":")[1]) <
                    Number(owner.session.split(":")[1])
            ) {
                return fetchRequest(request);
            }
            if (!owner || owner.session !== selected.session) {
                release(owner?.entry);
                owner = {
                    session: selected.session,
                    entry: null,
                    expiresAt: now() + ttlMs,
                };
                owners.set(clientId, owner);
            }
            owner.expiresAt = now() + ttlMs;
            if (!selected.preload) {
                const entry = owner.entry;
                if (entry?.active && entry.blob && entry.key === selected.key)
                    return serve(request, entry);
                return fetchRequest(request);
            }

            release(owner.entry);
            // Establish generation before awaiting headers; a late fetch cannot replace a newer preload.
            const entry = {
                key: selected.key,
                active: true,
                expiresAt: now() + ttlMs,
                reserved: 0,
                chunks: [],
                received: 0,
                blob: null,
                headers: null,
                removeAbortListener: null,
            };
            owner.entry = entry;
            const onAbort = () => release(entry);
            request.signal.addEventListener("abort", onAbort, { once: true });
            entry.removeAbortListener = () =>
                request.signal.removeEventListener("abort", onAbort);
            const current = () =>
                owners.get(clientId) === owner &&
                owner.entry === entry &&
                entry.active;
            let response;
            try {
                response = await fetchRequest(request);
            } catch (error) {
                release(entry);
                throw error;
            }
            prune();
            const length = captureLength(response);
            // Reserve the capture plus the transient Blob copy, before reading any bytes.
            if (
                !current() ||
                length === null ||
                length * 2 > maxTotalBytes - reservedBytes
            ) {
                release(entry);
                return response;
            }
            entry.reserved = length * 2;
            reservedBytes += entry.reserved;
            const reader = response.body.getReader();
            const stream = new ReadableStream(
                {
                    async pull(controller) {
                        try {
                            const result = await reader.read();
                            prune();
                            if (result.done) {
                                if (current() && entry.received === length) {
                                    entry.blob = new Blob(entry.chunks, {
                                        type: response.headers.get(
                                            "content-type",
                                        ),
                                    });
                                    entry.chunks = [];
                                    reservedBytes -= entry.reserved - length;
                                    entry.reserved = length;
                                    entry.headers = new Headers(
                                        response.headers,
                                    );
                                    entry.expiresAt = now() + ttlMs;
                                    owner.expiresAt = entry.expiresAt;
                                } else release(entry);
                                reader.releaseLock();
                                controller.close();
                                return;
                            }
                            if (current()) {
                                entry.received += result.value.byteLength;
                                if (entry.received > length) release(entry);
                                else
                                    entry.chunks.push(
                                        new Uint8Array(result.value),
                                    );
                            }
                            controller.enqueue(result.value);
                        } catch (error) {
                            release(entry);
                            reader.releaseLock();
                            controller.error(error);
                        }
                    },
                    async cancel(reason) {
                        release(entry);
                        try {
                            await reader.cancel(reason);
                        } finally {
                            reader.releaseLock();
                        }
                    },
                },
                { highWaterMark: 0 },
            );
            return new Response(stream, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        },
    };
};
