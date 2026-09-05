import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../../public/stream-preload-cache.js", import.meta.url),
    "utf8",
);
const origin = "https://soundspan.test";
const session = "11111111-1111-4111-8111-111111111111:1";
const secondSession = "11111111-1111-4111-8111-111111111111:2";
const encoder = new TextEncoder();
type Options = {
    maxCaptureBytes?: number;
    maxTotalBytes?: number;
    ttlMs?: number;
};
type Cache = {
    handle(request: Request, clientId: string): Promise<Response>;
    clearClient(clientId: string): void;
};
type Factory = (
    options: Options & {
        origin: string;
        now(): number;
        fetch(request: Request): Promise<Response>;
        parseRange(
            value: string,
            size: number,
        ): { start: number; end: number } | null;
    },
) => Cache;

function harness(options: Options = {}) {
    const self: { createCompletedStreamPreloadCache?: Factory } = {};
    vm.runInNewContext(
        source,
        {
            self,
            URL,
            Request,
            Response,
            Headers,
            ReadableStream,
            Blob,
            Uint8Array,
            Number,
            Map,
            Set,
        },
        { filename: "stream-preload-cache.js" },
    );
    assert.equal(typeof self.createCompletedStreamPreloadCache, "function");
    let clock = 0;
    const calls: Request[] = [];
    const responses: Array<Response | Promise<Response>> = [];
    const cache = self.createCompletedStreamPreloadCache!({
        origin,
        ...options,
        now: () => clock,
        fetch: async (request) => {
            calls.push(request);
            const response = responses.shift();
            assert.ok(response, "unexpected extra network fetch");
            return response;
        },
        parseRange(value, size) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(value);
            if (!match || (!match[1] && !match[2])) return null;
            const start = match[1]
                ? Number(match[1])
                : Math.max(0, size - Number(match[2]));
            const end =
                match[1] && match[2]
                    ? Math.min(Number(match[2]), size - 1)
                    : size - 1;
            return start < size && end >= start ? { start, end } : null;
        },
    });
    return {
        cache,
        calls,
        responses,
        advance: (ms: number) => {
            clock += ms;
        },
    };
}

function request(
    purpose = "interactive",
    capability = session,
    videoId = "ABCDEFGHIJK",
    init: RequestInit = {},
) {
    const url = new URL(`/api/ytmusic/stream-public/${videoId}`, origin);
    if (capability) url.searchParams.set("preloadSession", capability);
    if (purpose !== "interactive") url.searchParams.set("purpose", purpose);
    return new Request(url, init);
}
function body(text = "abcdef", extra: HeadersInit = {}, status = 200) {
    return new Response(encoder.encode(text), {
        status,
        headers: {
            "content-type": "audio/webm",
            "content-length": String(text.length),
            ...extra,
        },
    });
}
function controlled(length = 6) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled: unknown;
    const stream = new ReadableStream<Uint8Array>(
        {
            start(value) {
                controller = value;
            },
            cancel(reason) {
                cancelled = reason;
            },
        },
        { highWaterMark: 0 },
    );
    return {
        response: new Response(stream, {
            headers: {
                "content-type": "audio/webm",
                "content-length": String(length),
            },
        }),
        controller,
        cancelled: () => cancelled,
    };
}
async function warm(
    h: ReturnType<typeof harness>,
    clientId = "client-a",
    capability = session,
    videoId = "ABCDEFGHIJK",
) {
    h.responses.push(body());
    const response = await h.cache.handle(
        request("preload", capability, videoId),
        clientId,
    );
    assert.equal(await response.text(), "abcdef");
}

test("complete native preload is reused without a second fetch and preserves full and range bodies", async () => {
    const h = harness();
    await warm(h);
    const full = await h.cache.handle(request(), "client-a");
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-length"), "6");
    assert.equal(await full.text(), "abcdef");
    const range = await h.cache.handle(
        request("interactive", session, "ABCDEFGHIJK", {
            headers: { range: "bytes=2-4" },
        }),
        "client-a",
    );
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), "bytes 2-4/6");
    assert.equal(range.headers.get("content-length"), "3");
    assert.equal(await range.text(), "cde");
    const invalid = await h.cache.handle(
        request("interactive", session, "ABCDEFGHIJK", {
            headers: { range: "bytes=99-" },
        }),
        "client-a",
    );
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), "bytes */6");
    assert.equal(h.calls.length, 1);
});

test("prefix remains progressive, is not read ahead, and cannot be a hit before verified EOF", async () => {
    const h = harness();
    const pending = controlled();
    h.responses.push(pending.response);
    const response = await h.cache.handle(request("preload"), "client-a");
    pending.controller.enqueue(encoder.encode("abc"));
    const reader = response.body!.getReader();
    assert.deepEqual((await reader.read()).value, encoder.encode("abc"));
    h.responses.push(body("network"));
    assert.equal(
        await (await h.cache.handle(request(), "client-a")).text(),
        "network",
    );
    pending.controller.enqueue(encoder.encode("def"));
    pending.controller.close();
    assert.deepEqual((await reader.read()).value, encoder.encode("def"));
    assert.equal((await reader.read()).done, true);
    assert.equal(
        await (await h.cache.handle(request(), "client-a")).text(),
        "abcdef",
    );
    assert.equal(h.calls.length, 2);
});

test("only full 206 ranges and known unencoded audio of exact declared size can publish", async () => {
    for (const [response, eligible] of [
        [body("abcdef", { "content-range": "bytes 0-5/6" }, 206), true],
        [body("abcdef", { "content-type": "video/webm" }), true],
        [body("abcdef", { "content-range": "bytes 1-6/7" }, 206), false],
        [body("abcdef", { "content-range": "bytes 0-9/10" }, 206), false],
        [body("abcdef", { "content-type": "text/html" }), false],
        [body("abcdef", { "content-encoding": "gzip" }), false],
        [body("abcdef", { "cache-control": "private, no-store" }), false],
        [body("abcdef", { "content-length": "7" }), false],
        [body("abcdef", { "content-length": "5" }), false],
        [
            new Response("abcdef", {
                headers: { "content-type": "audio/webm" },
            }),
            false,
        ],
    ] as const) {
        const h = harness();
        h.responses.push(response);
        assert.equal(
            await (await h.cache.handle(request("preload"), "client-a")).text(),
            "abcdef",
        );
        h.responses.push(body("miss"));
        assert.equal(
            await (await h.cache.handle(request(), "client-a")).text(),
            eligible ? "abcdef" : "miss",
        );
        assert.equal(h.calls.length, eligible ? 1 : 2);
    }
});

test("cancellation and stream failure remain visible and never publish partial bytes", async () => {
    for (const fail of [false, true]) {
        const h = harness();
        const pending = controlled();
        h.responses.push(pending.response);
        const response = await h.cache.handle(request("preload"), "client-a");
        const reader = response.body!.getReader();
        pending.controller.enqueue(encoder.encode("abc"));
        await reader.read();
        const reason = new Error("fixture interruption");
        if (fail) {
            pending.controller.error(reason);
            await assert.rejects(reader.read(), (error) => error === reason);
        } else {
            await reader.cancel(reason);
            assert.equal(pending.cancelled(), reason);
        }
        h.responses.push(body("miss"));
        assert.equal(
            await (await h.cache.handle(request(), "client-a")).text(),
            "miss",
        );
    }
});

test("client, capability, and exact quality isolate entries; unrelated interactive track preserves next", async () => {
    const h = harness();
    await warm(h);
    const qualityRequest = request();
    const changedUrl = new URL(qualityRequest.url);
    changedUrl.searchParams.set("quality", "LOW");
    for (const [req, client] of [
        [request(), "other-client"],
        [new Request(changedUrl), "client-a"],
        [request("interactive", session, "ZYXWVUTSRQP"), "client-a"],
    ] as const) {
        h.responses.push(body("miss"));
        assert.equal(await (await h.cache.handle(req, client)).text(), "miss");
    }
    assert.equal(
        await (await h.cache.handle(request(), "client-a")).text(),
        "abcdef",
    );
    h.responses.push(body("new-owner"));
    assert.equal(
        await (
            await h.cache.handle(
                request("interactive", secondSession),
                "client-a",
            )
        ).text(),
        "new-owner",
    );
    h.responses.push(body("old-owner-miss"));
    assert.equal(
        await (await h.cache.handle(request(), "client-a")).text(),
        "old-owner-miss",
    );
});

test("new preload and session changes prevent old pending EOF or delayed headers from publishing", async () => {
    for (const changeSession of [false, true]) {
        const h = harness();
        const old = controlled();
        h.responses.push(old.response);
        const oldResponse = await h.cache.handle(
            request("preload"),
            "client-a",
        );
        const nextCapability = changeSession ? secondSession : session;
        await warm(h, "client-a", nextCapability, "ZYXWVUTSRQP");
        old.controller.enqueue(encoder.encode("abcdef"));
        old.controller.close();
        assert.equal(await oldResponse.text(), "abcdef");
        assert.equal(
            await (
                await h.cache.handle(
                    request("interactive", nextCapability, "ZYXWVUTSRQP"),
                    "client-a",
                )
            ).text(),
            "abcdef",
        );
    }
    const h = harness();
    let resolveOld!: (response: Response) => void;
    h.responses.push(
        new Promise<Response>((resolve) => {
            resolveOld = resolve;
        }),
    );
    const oldResponse = h.cache.handle(request("preload"), "client-a");
    await warm(h, "client-a", secondSession);
    resolveOld(body("stale"));
    assert.equal(await (await oldResponse).text(), "stale");
    assert.equal(
        await (
            await h.cache.handle(
                request("interactive", secondSession),
                "client-a",
            )
        ).text(),
        "abcdef",
    );
});

test("entry and global reservation limits include pending captures; expiry frees reservations", async () => {
    const h = harness({ maxCaptureBytes: 6, maxTotalBytes: 12, ttlMs: 10 });
    const pending = controlled();
    h.responses.push(pending.response);
    const pendingResponse = await h.cache.handle(
        request("preload"),
        "client-a",
    );
    await warm(h, "client-b"); // Pass-through: all budget is reserved by client-a.
    h.responses.push(body("miss"));
    assert.equal(
        await (await h.cache.handle(request(), "client-b")).text(),
        "miss",
    );
    h.advance(11);
    await warm(h, "client-b");
    pending.controller.enqueue(encoder.encode("abcdef"));
    pending.controller.close();
    assert.equal(await pendingResponse.text(), "abcdef");
    assert.equal(
        await (await h.cache.handle(request(), "client-b")).text(),
        "abcdef",
    );
    h.advance(11);
    h.responses.push(body("expired"));
    assert.equal(
        await (await h.cache.handle(request(), "client-b")).text(),
        "expired",
    );
    h.responses.push(body("toolarge"));
    assert.equal(
        await (await h.cache.handle(request("preload"), "client-a")).text(),
        "toolarge",
    );
    h.responses.push(body("miss"));
    assert.equal(
        await (await h.cache.handle(request(), "client-a")).text(),
        "miss",
    );
});

test("missing scope, unsupported routes/methods/purpose and redirected responses bypass untouched", async () => {
    const h = harness();
    for (const [req, client] of [
        [request("preload"), ""],
        [request("preload", ""), "client-a"],
        [request("preload", "invalid"), "client-a"],
        [
            new Request(
                "https://elsewhere.test/api/ytmusic/stream-public/ABCDEFGHIJK",
            ),
            "client-a",
        ],
        [
            new Request(
                `${origin}/api/library/tracks/one/stream?preloadSession=${session}`,
            ),
            "client-a",
        ],
        [
            request("preload", session, "ABCDEFGHIJK", { method: "POST" }),
            "client-a",
        ],
        [request("download"), "client-a"],
    ] as const) {
        const original = body();
        h.responses.push(original);
        assert.equal(await h.cache.handle(req, client), original);
        assert.equal(h.calls.at(-1), req);
    }
    const redirected = body();
    Object.defineProperty(redirected, "redirected", { value: true });
    h.responses.push(redirected);
    assert.equal(
        await h.cache.handle(request("preload"), "client-a"),
        redirected,
    );
});

test("an already aborted interactive request cannot consume a completed entry", async () => {
    const h = harness();
    await warm(h);
    const controller = new AbortController();
    const reason = new Error("request retired");
    controller.abort(reason);
    await assert.rejects(
        h.cache.handle(
            request("interactive", session, "ABCDEFGHIJK", {
                signal: controller.signal,
            }),
            "client-a",
        ),
        (error) => error === reason,
    );
    assert.equal(h.calls.length, 1);
});

test("consumer pull drives exactly one upstream read and cancel during pending read preserves its reason", async () => {
    const h = harness();
    let pulls = 0;
    let cancelled: unknown;
    let releasePull!: () => void;
    const pulled = new Promise<void>((resolve) => {
        releasePull = resolve;
    });
    const upstream = new ReadableStream<Uint8Array>(
        {
            pull() {
                pulls += 1;
                releasePull();
            },
            cancel(reason) {
                cancelled = reason;
            },
        },
        { highWaterMark: 0 },
    );
    h.responses.push(
        new Response(upstream, {
            headers: { "content-type": "audio/webm", "content-length": "6" },
        }),
    );
    const response = await h.cache.handle(request("preload"), "client-a");
    await Promise.resolve();
    assert.equal(pulls, 0);
    const reader = response.body!.getReader();
    const read = reader.read();
    await pulled;
    assert.equal(pulls, 1);
    const reason = new Error("consumer stopped");
    await reader.cancel(reason);
    assert.equal((await read).done, true);
    assert.equal(cancelled, reason);
    await warm(h);
    assert.equal(
        await (await h.cache.handle(request(), "client-a")).text(),
        "abcdef",
    );
});

test("an older generation arriving late cannot evict the same client new-session ready entry", async () => {
    const h = harness();
    await warm(h, "client-a", secondSession);
    h.responses.push(body("old-session"));
    assert.equal(
        await (await h.cache.handle(request("preload"), "client-a")).text(),
        "old-session",
    );
    assert.equal(
        await (
            await h.cache.handle(
                request("interactive", secondSession),
                "client-a",
            )
        ).text(),
        "abcdef",
    );
});

test("clearClient revokes ready and pending captures without affecting passthrough or another client", async () => {
    const h = harness();
    await warm(h, "client-b");
    const pending = controlled();
    h.responses.push(pending.response);
    const response = await h.cache.handle(request("preload"), "client-a");
    h.cache.clearClient("client-a");
    h.cache.clearClient("client-a");
    pending.controller.enqueue(encoder.encode("abcdef"));
    pending.controller.close();
    assert.equal(await response.text(), "abcdef");
    h.responses.push(body("miss"));
    assert.equal(
        await (await h.cache.handle(request(), "client-a")).text(),
        "miss",
    );
    assert.equal(
        await (await h.cache.handle(request(), "client-b")).text(),
        "abcdef",
    );
    h.cache.clearClient("client-b");
    h.responses.push(body("revoked"));
    assert.equal(
        await (await h.cache.handle(request(), "client-b")).text(),
        "revoked",
    );
});
