import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateLegacyDirectoryAudio } from "../../features/device-offline/legacyDirectoryMigration";
import type { DeviceOfflineDownloadRecord } from "../../features/device-offline/types";

function fixture() {
    const events: string[] = [];
    const record = {
        ownerId: "alice",
        status: "ready",
        mediaRef: "fsa1:old",
        totalBytes: 3,
        track: { title: "Track", artist: { name: "Artist" } },
        quality: "auto",
    } as DeviceOfflineDownloadRecord;
    let permission = "ready";
    let publish = true;
    const input = {
        ownerId: "alice",
        authGeneration: 1,
        records: [record],
        signal: new AbortController().signal,
        now: () => 100,
        vault: {
            inspectAccess: async () => ({
                status: "ready",
                storageKind: "browser-private",
            }),
            inspectLegacyAccess: async () => ({ status: permission }),
            open: async () => ({
                access: async (request: { kind: string }) => {
                    assert.equal(request.kind, "export");
                    events.push("read-original");
                    return {
                        url: "blob:local",
                        release: () => events.push("release"),
                    };
                },
                retain: async ({ stream }: { stream: ReadableStream }) => {
                    events.push("retain");
                    assert.equal(
                        (await new Response(stream).arrayBuffer()).byteLength,
                        3,
                    );
                    return {
                        ref: "opfs1:copy",
                        bytes: 3,
                        contentType: "audio/mpeg",
                        persistenceGranted: true,
                        discard: async () => {
                            events.push("discard-copy");
                        },
                    };
                },
            }),
        },
        read: async () => new Response(new Uint8Array([1, 2, 3])),
        publish: async (
            expected: DeviceOfflineDownloadRecord,
            next: DeviceOfflineDownloadRecord,
        ) => {
            assert.equal(expected, record);
            assert.equal(next.mediaRef, "opfs1:copy");
            events.push("publish");
            return publish;
        },
    };
    return {
        input: input as unknown as Parameters<
            typeof migrateLegacyDirectoryAudio
        >[0],
        events,
        deny: () => {
            permission = "permission-required";
        },
        conflict: () => {
            publish = false;
        },
    };
}

test("copies and verifies before publishing; leaves the public original untouched", async () => {
    const f = fixture();
    assert.equal(await migrateLegacyDirectoryAudio(f.input), 1);
    assert.deepEqual(f.events, [
        "read-original",
        "retain",
        "publish",
        "release",
    ]);
});
test("does not prompt or read the old directory without permission", async () => {
    const f = fixture();
    f.deny();
    assert.equal(await migrateLegacyDirectoryAudio(f.input), 0);
    assert.deepEqual(f.events, []);
});
test("a concurrent delete or update discards only the unpublished copy", async () => {
    const f = fixture();
    f.conflict();
    assert.equal(await migrateLegacyDirectoryAudio(f.input), 0);
    assert.deepEqual(f.events, [
        "read-original",
        "retain",
        "publish",
        "discard-copy",
        "release",
    ]);
});
test("does not migrate other owners or already private copies", async () => {
    const f = fixture();
    f.input.records = [
        { ...f.input.records[0], ownerId: "bob" },
        { ...f.input.records[0], mediaRef: "opfs1:done" as never },
    ];
    assert.equal(await migrateLegacyDirectoryAudio(f.input), 0);
    assert.deepEqual(f.events, []);
});
test("failure preserves the original metadata and releases its URL", async () => {
    const f = fixture();
    f.input.read = async () => {
        throw new Error("read failure");
    };
    assert.equal(await migrateLegacyDirectoryAudio(f.input), 0);
    assert.deepEqual(f.events, ["read-original", "release"]);
});

test("abort after retaining discards the unpublished copy and preserves the original", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.input.signal = controller.signal;
    const open = f.input.vault.open.bind(f.input.vault);
    f.input.vault.open = async (options) => {
        const session = await open(options);
        const retain = session.retain.bind(session);
        session.retain = async (request) => {
            const receipt = await retain(request);
            controller.abort(new Error("account changed"));
            return receipt;
        };
        return session;
    };
    await assert.rejects(
        migrateLegacyDirectoryAudio(f.input),
        /account changed/,
    );
    assert.deepEqual(f.events, [
        "read-original",
        "retain",
        "discard-copy",
        "release",
    ]);
});
