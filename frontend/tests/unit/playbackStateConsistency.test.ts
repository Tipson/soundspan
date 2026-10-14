import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClientCore } from "../../lib/api/core";
import { WithPlays } from "../../lib/api/plays";
import {
    getExplicitPlaybackCommandGeneration,
    markRemoteTrackChange,
    recordExplicitPlaybackSeek,
    recordQueueContextChange,
} from "../../lib/audio-engine/playbackAdvanceOrigin";

class Client extends WithPlays(ApiClientCore) {
    device = "device-a";
    protected override getPlaybackDeviceId() {
        return this.device;
    }
}

const absent = '"ps1.absent"';
const revisionA = '"ps1.11111111-1111-4111-8111-111111111111"';
const revisionB = '"ps1.22222222-2222-4222-8222-222222222222"';
const revisionC = '"ps1.33333333-3333-4333-8333-333333333333"';
const authority = { commandGeneration: 1 };
const playing = {
    playbackType: "track",
    trackId: "same-track",
    isPlaying: true,
    currentTime: 12.75,
    queue: [{ id: "same-track" }],
    currentIndex: 0,
};
const paused = { ...playing, isPlaying: false, currentTime: 14.125 };
function reply(state: unknown, etag = revisionA, status = 200) {
    return new Response(status === 204 ? null : JSON.stringify(state), {
        status,
        headers: {
            "Content-Type": "application/json",
            "X-Playback-State-Protocol": "1",
            ETag: etag,
        },
    });
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

test("save serializes writes and coalesces pending progress into the final pause", async (t) => {
    const client = new Client("http://soundspan.test");
    const active = deferred<Response>();
    const calls: RequestInit[] = [];
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            if (!options.method) return reply(null, absent);
            calls.push(options);
            return calls.length === 1 ? active.promise : reply({}, revisionB);
        },
    );
    await client.getPlaybackState();
    const first = client.savePlaybackState(playing, authority);
    await flush();
    const middle = client.savePlaybackState(
        { ...playing, currentTime: 13 },
        authority,
    );
    const last = client.savePlaybackState(paused, authority);
    await flush();
    assert.equal(calls.length, 1, "only one mutation may be in flight");
    active.resolve(reply({}, revisionA));
    await Promise.all([first, middle, last]);
    assert.equal(calls.length, 2);
    assert.equal(new Headers(calls[0].headers).get("If-Match"), absent);
    assert.equal(new Headers(calls[1].headers).get("If-Match"), revisionA);
    assert.deepEqual(JSON.parse(String(calls[1].body)), paused);
});

test("explicit clear retires old pending saves and new saves follow the tombstone", async (t) => {
    const client = new Client("http://soundspan.test");
    const active = deferred<Response>();
    const calls: RequestInit[] = [];
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            if (!options.method) return reply(null, absent);
            calls.push(options);
            if (calls.length === 1) return active.promise;
            return reply(
                {},
                calls.length === 2 ? revisionB : revisionC,
                options.method === "DELETE" ? 204 : 200,
            );
        },
    );
    await client.getPlaybackState();
    const first = client.savePlaybackState(playing, authority);
    await flush();
    const retired = client.savePlaybackState(paused, authority);
    const cleared = client.clearPlaybackState();
    const next = client.savePlaybackState(
        { ...playing, currentTime: 0 },
        { ...authority, commandGeneration: 2 },
    );
    await flush();
    assert.equal(calls.length, 1);
    active.resolve(reply({}, revisionA));
    await Promise.all([first, retired, cleared, next]);
    assert.deepEqual(
        calls.map((call) => call.method),
        ["POST", "DELETE", "POST"],
    );
    assert.equal(new Headers(calls[1].headers).get("If-Match"), revisionA);
    assert.equal(new Headers(calls[2].headers).get("If-Match"), revisionB);
});

test("412 retires pending and ticks remain blocked after polling until new semantic intent", async (t) => {
    const client = new Client("http://soundspan.test");
    const conflict = deferred<Response>();
    const calls: RequestInit[] = [];
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            calls.push(options);
            if (!options.method) return reply(null, revisionB);
            return calls.filter((call) => call.method === "POST").length === 1
                ? conflict.promise
                : reply({}, revisionC);
        },
    );
    await client.getPlaybackState();
    const active = client.savePlaybackState(playing, authority);
    const rejected = assert.rejects(
        active,
        (error: unknown) => (error as { status: number }).status === 412,
    );
    await flush();
    const pending = client.savePlaybackState(paused, authority);
    conflict.resolve(
        new Response(JSON.stringify({ error: "stale" }), { status: 412 }),
    );
    await Promise.all([rejected, pending]);
    await client.savePlaybackState(paused, authority);
    assert.equal(
        calls.length,
        2,
        "a clock tick cannot silently refresh the stale lease",
    );
    await client.getPlaybackState();
    await client.savePlaybackState(paused, authority);
    assert.equal(
        calls.filter((call) => call.method === "POST").length,
        1,
        "polling cannot renew authority after a conflict",
    );
    await client.savePlaybackState(paused, {
        ...authority,
        commandGeneration: 2,
    });
    assert.equal(calls.filter((call) => call.method === "POST").length, 2);
});

test("old-server weak ETag permits reading and suppresses every server mutation", async (t) => {
    const client = new Client("http://soundspan.test");
    const calls: RequestInit[] = [];
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            calls.push(options);
            return new Response(JSON.stringify(playing), {
                headers: { ETag: 'W/"express-old"' },
            });
        },
    );
    assert.deepEqual(await client.getPlaybackState(), playing);
    await client.savePlaybackState(paused, authority);
    assert.equal(await client.clearPlaybackState(), false);
    assert.ok(
        calls.every((call) => !call.method),
        "unsupported servers must never receive blind writes",
    );
});

test("a late read cannot regress the lease committed by a newer mutation", async (t) => {
    const client = new Client("http://soundspan.test");
    const late = deferred<Response>();
    let reads = 0;
    const writes: RequestInit[] = [];
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            if (!options.method)
                return ++reads === 2 ? late.promise : reply(null, absent);
            writes.push(options);
            return reply({}, writes.length === 1 ? revisionB : revisionC);
        },
    );
    await client.getPlaybackState();
    const oldRead = client.getPlaybackState();
    await client.savePlaybackState(playing, authority);
    late.resolve(reply(playing, revisionA));
    await oldRead;
    await client.savePlaybackState(paused, authority);
    assert.equal(new Headers(writes[1].headers).get("If-Match"), revisionB);
});

test("automatic clear pins the read revision and refuses a receipt from another account or device", async (t) => {
    const client = new Client("http://soundspan.test");
    const writes: RequestInit[] = [];
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            if (!options.method) return reply(playing, revisionA);
            writes.push(options);
            return reply({}, revisionB);
        },
    );
    const snapshot = await client.getPlaybackStateSnapshot();
    await client.clearPlaybackState(snapshot);
    assert.equal(new Headers(writes[0].headers).get("If-Match"), revisionA);
    client.setToken("account-b");
    assert.equal(await client.clearPlaybackState(snapshot), false);
    const current = await client.getPlaybackStateSnapshot();
    client.device = "device-b";
    assert.equal(await client.clearPlaybackState(current), false);
    assert.equal(writes.length, 1);
});

test("an old automatic clear cannot retire the lease of our own newer saves", async (t) => {
    const client = new Client("http://soundspan.test");
    const writes: RequestInit[] = [];
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            if (!options.method) return reply(playing, revisionA);
            writes.push(options);
            return options.method === "DELETE"
                ? new Response(JSON.stringify({ error: "stale" }), {
                      status: 412,
                  })
                : reply({}, revisionB);
        },
    );
    const snapshot = await client.getPlaybackStateSnapshot();
    await client.savePlaybackState(paused, authority);
    assert.equal(await client.clearPlaybackState(snapshot), false);
    await client.savePlaybackState(playing, authority);
    assert.deepEqual(
        writes.map((call) => call.method),
        ["POST", "POST"],
    );
    assert.equal(new Headers(writes[1].headers).get("If-Match"), revisionB);
});

for (const etag of [
    '"PS1.ABSENT"',
    'W/"ps1.absent"',
    '"ps1.absent", "ps1.absent"',
    "*",
]) {
    test(`malformed capability ${etag} cannot enable server writes`, async (t) => {
        const client = new Client("http://soundspan.test");
        const writes: RequestInit[] = [];
        t.mock.method(
            globalThis,
            "fetch",
            async (_url: unknown, options: RequestInit) => {
                if (options.method) writes.push(options);
                return reply(null, etag);
            },
        );
        await client.getPlaybackState();
        await client.savePlaybackState(playing, authority);
        assert.deepEqual(writes, []);
    });
}

test("metadata commits only after successful body parsing and auth guards, including 204", async (t) => {
    const client = new Client("http://soundspan.test");
    const body = deferred<string>();
    const held = reply(null);
    t.mock.method(held, "text", () => body.promise);
    t.mock.method(globalThis, "fetch", async () => held);
    let observed = 0;
    const old = client.request("/metadata", {
        onResponse: () => {
            observed++;
        },
    });
    const retired = assert.rejects(old, { name: "SupersededAuthSessionError" });
    await flush();
    client.setToken("new-account");
    body.resolve("null");
    await retired;
    assert.equal(observed, 0);
    t.mock.method(globalThis, "fetch", async () => reply(null, revisionB, 204));
    await client.request("/metadata", {
        onResponse: ({ headers }) => {
            observed++;
            assert.equal(headers.get("ETag"), revisionB);
        },
    });
    assert.equal(observed, 1);
});

test("concurrent metadata reads each receive their own matching body and receipt", async (t) => {
    const client = new Client("http://soundspan.test");
    let reads = 0;
    t.mock.method(globalThis, "fetch", async () =>
        ++reads === 1
            ? reply({ id: 1 }, revisionA)
            : reply({ id: 2 }, revisionB),
    );
    const receipts: string[] = [];
    const bodies = await Promise.all([
        client.request("/metadata", {
            onResponse: ({ headers }) => {
                receipts.push(String(headers.get("ETag")));
            },
        }),
        client.request("/metadata", {
            onResponse: ({ headers }) => {
                receipts.push(String(headers.get("ETag")));
            },
        }),
    ]);
    assert.deepEqual(bodies, [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(receipts, [revisionA, revisionB]);
});

test("invalid JSON cannot commit response metadata", async (t) => {
    const client = new Client("http://soundspan.test");
    t.mock.method(
        globalThis,
        "fetch",
        async () =>
            new Response("{invalid", {
                headers: { "X-Playback-State-Protocol": "1", ETag: revisionA },
            }),
    );
    let observed = false;
    await assert.rejects(
        client.request("/metadata", {
            onResponse: () => {
                observed = true;
            },
        }),
        SyntaxError,
    );
    assert.equal(observed, false);
});

for (const switchScope of ["account", "device"] as const) {
    test(`queued pause and clear cannot escape the retired ${switchScope} scope`, async (t) => {
        const client = new Client("http://soundspan.test");
        const active = deferred<Response>();
        const calls: RequestInit[] = [];
        t.mock.method(
            globalThis,
            "fetch",
            async (_url: unknown, options: RequestInit) => {
                calls.push(options);
                if (!options.method) return reply(null, absent);
                return active.promise;
            },
        );
        await client.getPlaybackState();
        const first = client.savePlaybackState(playing, authority);
        const completed = first.catch(() => undefined);
        await flush();
        const pending = client.savePlaybackState(paused, authority);
        const cleared = client.clearPlaybackState();
        if (switchScope === "account") client.setToken("account-b");
        else client.device = "device-b";
        active.resolve(reply({}, revisionA));
        await Promise.all([completed, pending, cleared]);
        assert.equal(calls.length, 2);
        assert.equal(new Headers(calls[1].headers).get("Authorization"), null);
    });
}

test("a queued explicit clear cannot acquire a fresh lease after the active write conflicts", async (t) => {
    const client = new Client("http://soundspan.test");
    const active = deferred<Response>();
    const calls: RequestInit[] = [];
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            calls.push(options);
            if (!options.method) return reply(null, revisionA);
            return calls.filter((call) => call.method).length === 1
                ? active.promise
                : reply({}, revisionB);
        },
    );
    await client.getPlaybackState();
    const first = client.savePlaybackState(playing, authority);
    const rejected = assert.rejects(
        first,
        (error: unknown) => (error as { status: number }).status === 412,
    );
    await flush();
    const pause = client.savePlaybackState(paused, authority);
    const clear = client.clearPlaybackState();
    const afterClear = client.savePlaybackState(playing, authority);
    active.resolve(
        new Response(JSON.stringify({ error: "stale" }), { status: 412 }),
    );
    await Promise.all([rejected, pause, clear, afterClear]);
    await client.savePlaybackState(paused, authority);
    assert.equal(
        calls.length,
        2,
        "the earlier clear must not delete the other writer's winning queue",
    );
});

test("a poll-generated authority cannot unlock a writer after a conflict", async (t) => {
    const client = new Client("http://soundspan.test");
    let writes = 0;
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            if (!options.method) return reply(null, revisionA);
            writes++;
            return writes === 1
                ? new Response(JSON.stringify({ error: "stale" }), {
                      status: 412,
                  })
                : reply({}, revisionB);
        },
    );
    await client.getPlaybackState();
    const commandGeneration = getExplicitPlaybackCommandGeneration();
    await assert.rejects(
        client.savePlaybackState(playing, { commandGeneration }),
    );
    await client.getPlaybackState();
    markRemoteTrackChange("old-song", "polled-song");
    recordQueueContextChange();
    await client.savePlaybackState(paused, {
        commandGeneration: getExplicitPlaybackCommandGeneration(),
    });
    assert.equal(writes, 1);
    recordExplicitPlaybackSeek();
    await client.savePlaybackState(paused, {
        commandGeneration: getExplicitPlaybackCommandGeneration(),
    });
    assert.equal(writes, 2);
});
