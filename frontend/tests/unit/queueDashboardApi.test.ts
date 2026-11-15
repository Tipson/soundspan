import assert from "node:assert/strict";
import { after, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { api } from "../../lib/api";

GlobalRegistrator.register({ url: "https://music.example/admin" });
after(() => {
    api.clearToken();
    GlobalRegistrator.unregister();
});

test("dashboard session creation and removal use authenticated cookie-enabled API requests", async (context) => {
    assert.equal(typeof api.createQueueDashboardSession, "function");
    assert.equal(typeof api.endQueueDashboardSession, "function");
    api.setToken("fixture-access");
    const calls: { url: string; options: RequestInit | undefined }[] = [];
    const fetchMock = context.mock.method(
        globalThis,
        "fetch",
        async (input: string | URL | Request, options?: RequestInit) => {
            calls.push({ url: String(input), options });
            return calls.length === 2
                ? Response.json({ expiresIn: 900 })
                : new Response(null, { status: 204 });
        },
    );
    try {
        assert.deepEqual(await api.createQueueDashboardSession(), {
            expiresIn: 900,
        });
        await api.endQueueDashboardSession();
        assert.equal(calls.length, 3);
        for (const [index, call] of calls.entries()) {
            assert.ok(
                call.url.endsWith(
                    index === 0
                        ? "/api/admin/queues/binding"
                        : "/api/admin/queues/session",
                ),
            );
            assert.equal(call.options?.method, index < 2 ? "POST" : "DELETE");
            assert.equal(call.options?.credentials, "include");
            assert.equal(
                new Headers(call.options?.headers).get("Authorization"),
                "Bearer fixture-access",
            );
        }
        const url = new URL(api.getQueueDashboardUrl(), window.location.origin);
        assert.equal(url.pathname, "/api/admin/queues");
        assert.equal(url.search, "");
        assert.equal(url.hash, "");
    } finally {
        fetchMock.mock.restore();
        api.clearToken();
    }
});

test("invalid dashboard expiry metadata is rejected before a tab can be treated as ready", async (context) => {
    for (const result of [
        null,
        { expiresIn: "900" },
        { expiresIn: 0 },
        { expiresIn: 901 },
    ]) {
        const fetchMock = context.mock.method(
            globalThis,
            "fetch",
            async (input: string | URL | Request) =>
                String(input).endsWith("/binding")
                    ? new Response(null, { status: 204 })
                    : Response.json(result),
        );
        try {
            await assert.rejects(
                () => api.createQueueDashboardSession(),
                /Invalid queue dashboard session response/,
            );
        } finally {
            fetchMock.mock.restore();
        }
    }
});

test("logout during a delayed binding response prevents the follow-up credential mint", async (context) => {
    api.setToken("fixture-admin");
    let finish: ((value: Response) => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const calls: string[] = [];
    const fetchMock = context.mock.method(
        globalThis,
        "fetch",
        (input: string | URL | Request) => {
            calls.push(String(input));
            entered?.();
            return new Promise<Response>((resolve) => {
                finish = resolve;
            });
        },
    );
    const opening = api.createQueueDashboardSession();
    const rejected = assert.rejects(opening, /Authentication session changed/);
    try {
        await started;
        api.clearToken();
        assert.ok(finish);
        finish(new Response(null, { status: 204 }));
        await rejected;
        assert.equal(calls.length, 1);
        assert.ok(calls[0].endsWith("/api/admin/queues/binding"));
    } finally {
        fetchMock.mock.restore();
        api.clearToken();
    }
});

test("cancellation during bootstrap prevents a later credential request", async (context) => {
    const controller = new AbortController();
    let finish: ((value: Response) => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    let calls = 0;
    const fetchMock = context.mock.method(globalThis, "fetch", () => {
        calls += 1;
        entered?.();
        return new Promise<Response>((resolve) => {
            finish = resolve;
        });
    });
    const opening = api.createQueueDashboardSession(controller.signal);
    const rejected = assert.rejects(opening, /cancelled|aborted/i);
    try {
        await started;
        controller.abort();
        assert.ok(finish);
        finish(new Response(null, { status: 204 }));
        await rejected;
        assert.equal(calls, 1);
    } finally {
        fetchMock.mock.restore();
    }
});
