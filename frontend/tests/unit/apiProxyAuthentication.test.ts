import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { proxyRequest } from "../../lib/apiProxy";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("Next API fallback promotes a clean media cookie to Authorization without forwarding the cookie", async (t) => {
    const fetchMock = t.mock.method(
        globalThis,
        "fetch",
        async () => new Response("image", { status: 200 }),
    );
    const request = new Request(
        "https://soundspan.test/api/library/cover-art/album?size=320",
        {
            headers: {
                cookie: "theme=dark; soundspan_media_auth=cookie.jwt.signature",
            },
        },
    );

    const response = await proxyRequest(request, "api/library/cover-art/album");
    await response.text();

    assert.equal(fetchMock.mock.callCount(), 1);
    const [target, init] = fetchMock.mock.calls[0]!.arguments as [
        string,
        RequestInit,
    ];
    assert.equal(
        target,
        "http://127.0.0.1:3006/api/library/cover-art/album?size=320",
    );
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer cookie.jwt.signature");
    assert.equal(headers.get("cookie"), "theme=dark");
});

test("Next API fallback converts a legacy query token to Authorization and removes it from the target URL", async (t) => {
    const fetchMock = t.mock.method(
        globalThis,
        "fetch",
        async () => new Response("image", { status: 200 }),
    );
    const request = new Request(
        "https://soundspan.test/api/browse/ytmusic/image?url=https%3A%2F%2Flh3.googleusercontent.com%2Fcover.jpg&token=query.jwt.signature",
    );

    const response = await proxyRequest(request, "api/browse/ytmusic/image");
    await response.text();

    const [target, init] = fetchMock.mock.calls[0]!.arguments as [
        string,
        RequestInit,
    ];
    assert.equal(
        target,
        "http://127.0.0.1:3006/api/browse/ytmusic/image?url=https%3A%2F%2Flh3.googleusercontent.com%2Fcover.jpg",
    );
    assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer query.jwt.signature",
    );
});

test("Next API fallback does not use the media cookie to authenticate mutations", async (t) => {
    const fetchMock = t.mock.method(
        globalThis,
        "fetch",
        async () => new Response(null, { status: 204 }),
    );
    const request = new Request("https://soundspan.test/api/settings", {
        method: "POST",
        headers: {
            cookie: "theme=dark; soundspan_media_auth=cookie.jwt.signature",
        },
    });

    const response = await proxyRequest(request, "api/settings");

    assert.equal(response.status, 204);
    const [, init] = fetchMock.mock.calls[0]!.arguments as [
        string,
        RequestInit,
    ];
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("cookie"), "theme=dark");
});

test("Next API fallback authenticates an exact audio GET and preserves byte ranges end to end", async (t) => {
    const bytes = Uint8Array.from([2, 3, 4, 5]);
    const fetchMock = t.mock.method(globalThis, "fetch", async () => {
        return new Response(bytes, {
            status: 206,
            headers: {
                "content-type": "audio/mpeg",
                "content-range": "bytes 2-5/10",
                "content-length": "4",
                "accept-ranges": "bytes",
            },
        });
    });
    const request = new Request(
        "https://soundspan.test/api/library/tracks/track-1/stream?quality=original",
        {
            headers: {
                cookie: "theme=dark; soundspan_media_auth=cookie.jwt.signature",
                range: "bytes=2-5",
            },
        },
    );

    const response = await proxyRequest(
        request,
        "api/library/tracks/track-1/stream",
    );

    const [target, init] = fetchMock.mock.calls[0]!.arguments as [
        string,
        RequestInit,
    ];
    const headers = new Headers(init.headers);
    assert.equal(
        target,
        "http://127.0.0.1:3006/api/library/tracks/track-1/stream?quality=original",
    );
    assert.equal(headers.get("authorization"), "Bearer cookie.jwt.signature");
    assert.equal(headers.get("range"), "bytes=2-5");
    assert.equal(headers.get("cookie"), "theme=dark");
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(response.headers.get("content-length"), "4");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("media cookie cannot authenticate mutations or near-miss stream paths", async (t) => {
    const fetchMock = t.mock.method(
        globalThis,
        "fetch",
        async () => new Response(null, { status: 204 }),
    );
    const cases = [
        {
            url: "https://soundspan.test/api/library/tracks/track-1/stream?token=query.jwt.signature",
            method: "POST",
            targetPath: "api/library/tracks/track-1/stream",
        },
        {
            url: "https://soundspan.test/api/library/tracks/track-1/stream/delete?token=query.jwt.signature",
            method: "GET",
            targetPath: "api/library/tracks/track-1/stream/delete",
        },
        {
            url: "https://soundspan.test/api/tidal-streaming/stream",
            method: "GET",
            targetPath: "api/tidal-streaming/stream",
        },
    ];

    for (const item of cases) {
        const response = await proxyRequest(
            new Request(item.url, {
                method: item.method,
                headers: {
                    cookie: "theme=dark; soundspan_media_auth=cookie.jwt.signature",
                },
            }),
            item.targetPath,
        );
        assert.equal(response.status, 204);
    }

    for (const call of fetchMock.mock.calls) {
        const [, init] = call.arguments as [string, RequestInit];
        const headers = new Headers(init.headers);
        assert.equal(headers.get("authorization"), null);
        assert.equal(headers.get("cookie"), "theme=dark");
        assert.doesNotMatch(String(call.arguments[0]), /token=/);
    }
});
