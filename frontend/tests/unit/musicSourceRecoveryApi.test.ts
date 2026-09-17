import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClientCore } from "../../lib/api/core";
import { WithMusicSources } from "../../lib/api/musicSources";

class Client extends WithMusicSources(ApiClientCore) {}
const recording = {
    title: "Track",
    artists: ["Artist"],
    duration: 240,
    contentVersion: "unknown" as const,
};
const leaseId = "a".repeat(48);
test("catalog API encodes query and keeps only sanitized recording metadata", async (t) => {
    let requested = "";
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        requested = String(url);
        return Response.json({
            tracks: [
                {
                    ...recording,
                    provider: "vk",
                    id: "1_2",
                    preview: false,
                    token: "secret",
                },
            ],
            unavailable: ["yandex"],
        });
    });
    const result = await new Client(
        "https://soundspan.test",
    ).searchMusicSourceCatalog("A & B");
    assert.ok(requested.includes("query=A+%26+B"));
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.deepEqual(result.unavailable, ["yandex"]);
});
test("selected playback validates the provider and owned lease path", async (t) => {
    const candidate = {
        ...recording,
        provider: "vk" as const,
        id: "1_2",
        preview: false,
    };
    let body: unknown;
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            body = JSON.parse(String(options.body));
            return Response.json({
                playback: {
                    leaseId,
                    provider: "vk",
                    streamPath: `/api/music-sources/leases/${leaseId}/stream`,
                },
            });
        },
    );
    assert.equal(
        await new Client().resolveMusicSourcePlayback(
            candidate,
            new AbortController().signal,
        ),
        `/api/music-sources/leases/${leaseId}/stream`,
    );
    assert.deepEqual(body, {
        ...recording,
        provider: "vk",
        providerTrackId: "1_2",
    });
    t.mock.method(globalThis, "fetch", async () =>
        Response.json({
            playback: {
                leaseId,
                provider: "yandex",
                streamPath: `/api/music-sources/leases/${leaseId}/stream`,
            },
        }),
    );
    await assert.rejects(new Client().resolveMusicSourcePlayback(candidate));
});
test("catalog selection includes exact provider id in resolution", async (t) => {
    let body: unknown;
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            body = JSON.parse(String(options.body));
            return Response.json({ playback: null });
        },
    );
    await new Client().resolveMusicSource({
        ...recording,
        provider: "vk",
        id: "1_2",
        preview: false,
    });
    assert.deepEqual(body, {
        ...recording,
        provider: "vk",
        providerTrackId: "1_2",
    });
});
test("recovery requests server selection with cancellation and validates a private stream path", async (t) => {
    const calls: RequestInit[] = [];
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, options: RequestInit) => {
            calls.push(options);
            return Response.json({
                playback: {
                    leaseId,
                    provider: "yandex",
                    streamPath: `/api/music-sources/leases/${leaseId}/stream`,
                },
            });
        },
    );
    const controller = new AbortController();
    const url = await new Client(
        "https://soundspan.test",
    ).resolveMusicSourceForRecovery(recording, controller.signal);
    assert.equal(url, `/api/music-sources/leases/${leaseId}/stream`);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(String(calls[0].body)), recording);
    assert.ok(calls[0].signal);
});
test("recovery refuses external or mismatched lease URLs", async (t) => {
    for (const streamPath of [
        "https://external.test/audio.mp3",
        `/api/music-sources/leases/${"b".repeat(48)}/stream`,
        "/api/admin",
    ]) {
        t.mock.method(globalThis, "fetch", async () =>
            Response.json({
                playback: { leaseId, provider: "yandex", streamPath },
            }),
        );
        await assert.rejects(
            new Client().resolveMusicSourceForRecovery(recording),
        );
        t.mock.restoreAll();
    }
});
test("recovery preserves no-match as an explicit null result", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
        Response.json({ playback: null }),
    );
    assert.equal(
        await new Client().resolveMusicSourceForRecovery(recording),
        null,
    );
});
