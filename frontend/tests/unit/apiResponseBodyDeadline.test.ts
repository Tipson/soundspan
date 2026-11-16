import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";
import { ApiClientCore } from "../../lib/api/core";

class TestApiClient extends ApiClientCore {}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function fixture(
    context: TestContext,
    options: {
        healthySecond?: boolean;
        invalidCompleteBody?: boolean;
        refreshUnavailable?: boolean;
    } = {},
) {
    const headerSeen = deferred<void>();
    const closedResponse = deferred<void>();
    let requests = 0;
    const server = createServer((request, response: ServerResponse) => {
        request.resume();
        requests++;
        if (options.refreshUnavailable && request.url !== "/api/auth/refresh") {
            response.writeHead(401, { "Content-Type": "application/json" });
            response.end('{"error":"Login required","code":"AUTH_REQUIRED"}');
            return;
        }
        if (options.healthySecond && requests === 2) {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end('{"restored":true}');
            return;
        }
        response.writeHead(options.refreshUnavailable ? 503 : 200, {
            "Content-Type": "application/json",
        });
        response.flushHeaders();
        response.write('{"id":"');
        if (options.invalidCompleteBody) response.end();
        response.once("close", () => closedResponse.resolve());
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const nativeFetch = globalThis.fetch;
    context.mock.method(
        globalThis,
        "fetch",
        async (input: string | URL | Request, init?: RequestInit) => {
            const response = await nativeFetch(input, init);
            if (
                !options.refreshUnavailable ||
                String(input).endsWith("/api/auth/refresh")
            )
                headerSeen.resolve();
            return response;
        },
    );
    return {
        client: new TestApiClient(`http://127.0.0.1:${address.port}`),
        headerSeen: headerSeen.promise,
        closedResponse: closedResponse.promise,
        requests: () => requests,
        async close() {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        },
    };
}

async function boundedResult<T>(pending: Promise<T>, milliseconds = 5000) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = Symbol("body deadline did not settle");
    try {
        return await Promise.race([
            pending,
            new Promise<typeof expired>((resolve) => {
                timer = setTimeout(() => resolve(expired), milliseconds);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

test("a POST deadline covers a real stalled HTTP body after its headers without retrying the mutation", async (context) => {
    const f = await fixture(context);
    const pending = f.client
        .request("/plays/idempotent", { method: "POST", timeoutMs: 1000 })
        .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        );
    try {
        assert.notEqual(
            typeof (await boundedResult(f.headerSeen)),
            "symbol",
            "fixture must deliver headers before testing the body deadline",
        );
        const result = await boundedResult(pending);
        assert.notEqual(
            typeof result,
            "symbol",
            "headers must not retire the body deadline",
        );
        assert.ok(typeof result !== "symbol" && "error" in result);
        assert.equal((result.error as { status?: number }).status, 408);
        assert.notEqual(
            typeof (await boundedResult(f.closedResponse)),
            "symbol",
            "timeout must close the response, not leave a detached body read",
        );
        assert.equal(f.requests(), 1);
    } finally {
        await f.close();
        await pending;
    }
});

test("a stalled GET body has the existing single bounded retry and can recover", async (context) => {
    const f = await fixture(context, { healthySecond: true });
    const pending = f.client
        .request("/system/features", { timeoutMs: 1000 })
        .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        );
    try {
        assert.notEqual(
            typeof (await boundedResult(f.headerSeen)),
            "symbol",
            "fixture must deliver headers before testing the body deadline",
        );
        const result = await boundedResult(pending);
        assert.notEqual(
            typeof result,
            "symbol",
            "GET body timeout must reach its bounded retry",
        );
        assert.deepEqual(result, { value: { restored: true } });
        assert.equal(f.requests(), 2);
    } finally {
        await f.close();
        await pending;
    }
});

test("a deadline-bound aggregate GET can disable body-timeout retry", async (context) => {
    const f = await fixture(context);
    const pending = f.client
        .request("/personalized/home", {
            timeoutMs: 1000,
            retryOnTimeout: false,
        })
        .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        );
    try {
        assert.notEqual(
            typeof (await boundedResult(f.headerSeen)),
            "symbol",
            "fixture must deliver headers before testing the body deadline",
        );
        const result = await boundedResult(pending);
        assert.ok(
            typeof result !== "symbol" && "error" in result,
            "the body must terminate even when retry is disabled",
        );
        assert.equal((result.error as { status?: number }).status, 408);
        assert.equal(f.requests(), 1);
    } finally {
        await f.close();
        await pending;
    }
});

test("upstream revocation cancels an already received response body without mutation retry", async (context) => {
    const f = await fixture(context);
    const abort = new AbortController();
    const pending = f.client
        .request("/plays/idempotent", {
            method: "POST",
            timeoutMs: 10_000,
            signal: abort.signal,
        })
        .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        );
    try {
        assert.notEqual(
            typeof (await boundedResult(f.headerSeen)),
            "symbol",
            "fixture must deliver headers before testing the body deadline",
        );
        abort.abort();
        const result = await boundedResult(pending);
        assert.ok(
            typeof result !== "symbol" && "error" in result,
            "revocation must reach the response body after headers",
        );
        assert.notEqual((result.error as { status?: number }).status, 408);
        assert.notEqual(
            typeof (await boundedResult(f.closedResponse)),
            "symbol",
        );
        assert.equal(f.requests(), 1);
    } finally {
        await f.close();
        await pending;
    }
});

test("a complete malformed JSON response is not disguised as a retryable transport timeout", async (context) => {
    const f = await fixture(context, { invalidCompleteBody: true });
    try {
        await assert.rejects(
            f.client.request("/system/features", { timeoutMs: 1000 }),
            SyntaxError,
        );

        assert.equal(f.requests(), 1);
    } finally {
        await f.close();
    }
});

test("a non-success refresh closes an unread stalled body and retains the current session", async (context) => {
    const f = await fixture(context, { refreshUnavailable: true });
    f.client.setToken("fixture-access", "fixture-refresh");
    context.mock.method(f.client, "getRefreshToken", () => "fixture-refresh");
    const pending = f.client
        .request("/system/features", { timeoutMs: 1000 })
        .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        );
    try {
        assert.notEqual(
            typeof (await boundedResult(f.headerSeen)),
            "symbol",
            "fixture must deliver headers before testing the body deadline",
        );
        const result = await boundedResult(pending);
        assert.ok(typeof result !== "symbol" && "error" in result);
        assert.equal((result.error as { status?: number }).status, 401);
        assert.equal(f.client.getToken(), "fixture-access");
        assert.notEqual(
            typeof (await boundedResult(f.closedResponse)),
            "symbol",
            "an unread refresh body must not retain a detached connection",
        );
        assert.equal(f.requests(), 2);
    } finally {
        await f.close();
        await pending;
        f.client.clearToken();
    }
});
