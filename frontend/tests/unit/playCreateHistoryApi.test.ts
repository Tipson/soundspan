import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test, { after, beforeEach } from "node:test";
import { ApiClientCore } from "../../lib/api/core";
import { WithPlays } from "../../lib/api/plays";
import { getAuthRuntimeLease } from "../../lib/auth-runtime-generation";
import { installPlayCreateJournalBridge } from "../../lib/playCreateJournalBridge";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
);
const values = new Map<string, string>();
const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
        values.set(key, value);
    },
    removeItem: (key: string) => {
        values.delete(key);
    },
};
Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), { localStorage: storage }),
});
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
});
beforeEach(() => values.clear());
after(() => {
    if (originalWindow)
        Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalStorage)
        Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});
class Client extends WithPlays(ApiClientCore) {}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
async function bounded<T>(pending: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            pending,
            new Promise<never>((_yes, no) => {
                timer = setTimeout(
                    () => no(new Error("HTTP fixture timeout")),
                    4000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
function json(response: ServerResponse, body: unknown, status = 200) {
    response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "private,no-store",
    });
    response.end(JSON.stringify(body));
}
async function fixture(
    run: (client: Client, origin: string, requests: string[]) => Promise<void>,
    handler: (url: string, response: ServerResponse) => void,
) {
    const requests: string[] = [];
    const server = createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        handler(request.url ?? "", response);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const client = new Client(origin);
    client.setToken("fixture-token", "fixture-refresh");
    try {
        await run(client, origin, requests);
    } finally {
        client.clearToken();
        const closed = new Promise<void>((yes, no) =>
            server.close((error) => (error ? no(error) : yes())),
        );
        server.closeAllConnections();
        await closed;
    }
}
function install(
    client: object,
    events: string[],
    finish?: (success: boolean) => Promise<void>,
) {
    return installPlayCreateJournalBridge({
        api: client,
        authLease: getAuthRuntimeLease(),
        runtime: {
            begin() {
                return null;
            },
            async close() {
                events.push("close");
            },
            suspendForHistoryClear() {
                events.push("suspend");
                return async (success) => {
                    events.push(`finish:${success}`);
                    await finish?.(success);
                };
            },
        },
    });
}
test("history DELETE suspends synchronously before HTTP and finalizes successful accounting without waiting for it", async () => {
    const arrived = deferred<ServerResponse>();
    await fixture(
        async (client, _origin, requests) => {
            const events: string[] = [];
            const dispose = install(
                client,
                events,
                () => new Promise<void>(() => undefined),
            );
            try {
                const pending = client.clearPlayHistory("all");
                void pending.catch(() => undefined);
                assert.deepEqual(events, ["suspend"]);
                const response = await bounded(arrived.promise);
                assert.deepEqual(requests, [
                    "DELETE /api/plays/history?range=all",
                ]);
                const body = { success: true, range: "all", deletedCount: 9 };
                json(response, body);
                assert.deepEqual(await bounded(pending), body);
                assert.deepEqual(events, ["suspend", "finish:true"]);
            } finally {
                dispose();
            }
        },
        (_url, response) => arrived.resolve(response),
    );
});
test("failed DELETE resumes the original accounting and preserves the original HTTP failure without retry", async () => {
    await fixture(
        async (client, _origin, requests) => {
            const events: string[] = [];
            const dispose = install(client, events);
            try {
                await assert.rejects(client.clearPlayHistory("7d"), {
                    status: 503,
                });
                assert.deepEqual(events, ["suspend", "finish:false"]);
                assert.deepEqual(requests, [
                    "DELETE /api/plays/history?range=7d",
                ]);
            } finally {
                dispose();
            }
        },
        (_url, response) =>
            json(response, { error: "Temporarily unavailable" }, 503),
    );
});
test("a non-successful response does not retire history even when HTTP completed successfully", async () => {
    await fixture(
        async (client) => {
            const events: string[] = [];
            const dispose = install(client, events);
            try {
                const result = await client.clearPlayHistory("30d");
                assert.equal(result.success, false);
                assert.deepEqual(events, ["suspend", "finish:false"]);
            } finally {
                dispose();
            }
        },
        (_url, response) =>
            json(response, { success: false, range: "30d", deletedCount: 0 }),
    );
});
test("a different API client never suspends the mounted runtime", async () => {
    await fixture(
        async (client, origin) => {
            const events: string[] = [];
            const dispose = install(client, events);
            const other = new Client(origin);
            try {
                await other.clearPlayHistory("all");
                assert.deepEqual(events, []);
            } finally {
                dispose();
            }
        },
        (_url, response) =>
            json(response, { success: true, range: "all", deletedCount: 0 }),
    );
});
test("accounting preserves a legacy null response instead of inventing an exception", async () => {
    await fixture(
        async (client) => {
            const events: string[] = [];
            const dispose = install(client, events);
            try {
                assert.equal(await client.clearPlayHistory("all"), null);
                assert.deepEqual(events, ["suspend", "finish:false"]);
            } finally {
                dispose();
            }
        },
        (_url, response) => json(response, null),
    );
});
test("a late DELETE response finishes only its captured old runtime after replacement", async () => {
    const arrived = deferred<ServerResponse>();
    await fixture(
        async (client) => {
            const old: string[] = [],
                replacement: string[] = [];
            const disposeOld = install(client, old);
            let disposeNew: (() => void) | undefined;
            try {
                const pending = client.clearPlayHistory("all");
                void pending.catch(() => undefined);
                const response = await bounded(arrived.promise);
                disposeNew = install(client, replacement);
                json(response, {
                    success: true,
                    range: "all",
                    deletedCount: 1,
                });
                await bounded(pending);
                assert.deepEqual(old, ["suspend", "close", "finish:true"]);
                assert.deepEqual(replacement, []);
            } finally {
                disposeOld();
                disposeNew?.();
            }
        },
        (_url, response) => arrived.resolve(response),
    );
});
test("accounting finalization failure cannot mask a successful DELETE result", async (context) => {
    const warnings: unknown[][] = [];
    context.mock.method(console, "warn", (...args: unknown[]) => {
        warnings.push(args);
    });
    await fixture(
        async (client) => {
            const events: string[] = [];
            const dispose = install(client, events, async () => {
                throw new Error("private-data");
            });
            try {
                assert.equal(
                    (await client.clearPlayHistory("365d")).success,
                    true,
                );
                await Promise.resolve();
                await Promise.resolve();
                assert.deepEqual(events, ["suspend", "finish:true"]);
                assert.equal(
                    JSON.stringify(warnings).includes("private-data"),
                    false,
                );
            } finally {
                dispose();
            }
        },
        (_url, response) =>
            json(response, { success: true, range: "365d", deletedCount: 0 }),
    );
});
