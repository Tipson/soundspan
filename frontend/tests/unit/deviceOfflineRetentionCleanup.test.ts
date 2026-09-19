import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomInt } from "node:crypto";
import {
    retainDeviceAudioFile,
    type RetainDeviceAudioFileInput,
} from "../../features/device-offline/vaultRetention";
import type {
    DeviceAudioVault,
    DeviceAudioVaultRef,
} from "../../features/device-offline/vault/types";

function fixture(status = 200, cancelError?: Error) {
    let cancellations = 0;
    let retains = 0;
    const body = new ReadableStream<Uint8Array>({
        cancel() {
            cancellations += 1;
            if (cancelError) throw cancelError;
        },
    });
    const storageError = new Error("Storage unavailable");
    const vault: DeviceAudioVault = {
        async inspectAccess() {
            throw new Error("Unexpected access inspection");
        },
        async requestAccess() {
            throw new Error("Unexpected prompt");
        },
        async open({ ownerId, authGeneration }) {
            return {
                ownerId,
                authGeneration,
                storage: { kind: "browser-private", label: "Test" },
                async retain() {
                    retains += 1;
                    throw storageError;
                },
                async access() {
                    throw new Error("Unexpected file access");
                },
            };
        },
    };
    const input: RetainDeviceAudioFileInput = {
        vault,
        ownerId: "owner",
        authGeneration: 1,
        track: {
            id: "track",
            title: "Track",
            artist: { name: "Artist" },
            album: { title: "Album" },
            duration: 180,
        },
        quality: "HIGH",
        sourceUrl: "https://soundspan.test/api/ytmusic/stream-public/track",
        signal: new AbortController().signal,
        request: async () => new Response(body, { status }),
        onHeaders: async () => {},
        onProgress: async () => {},
    };
    return {
        input,
        storageError,
        cancellations: () => cancellations,
        retains: () => retains,
    };
}

test("rejected HTTP response cancels its unread body before retry", async () => {
    const scenario = fixture(503);
    await assert.rejects(retainDeviceAudioFile(scenario.input), /HTTP 503/);
    assert.equal(scenario.cancellations(), 1);
    assert.equal(scenario.retains(), 0);
});

test("failed metadata setup cancels the audio response without retaining a file", async () => {
    const scenario = fixture();
    const metadataError = new Error("Metadata transaction failed");
    scenario.input.onHeaders = async () => {
        throw metadataError;
    };
    await assert.rejects(
        retainDeviceAudioFile(scenario.input),
        (error) => error === metadataError,
    );
    assert.equal(scenario.cancellations(), 1);
    assert.equal(scenario.retains(), 0);
});

test("storage rejection before acquiring the reader cancels the response", async () => {
    const scenario = fixture();
    await assert.rejects(
        retainDeviceAudioFile(scenario.input),
        (error) => error === scenario.storageError,
    );
    assert.equal(scenario.cancellations(), 1);
    assert.equal(scenario.retains(), 1);
});

test("response cleanup failure preserves the original HTTP failure", async () => {
    const scenario = fixture(503, new Error("Cancel failed"));
    await assert.rejects(retainDeviceAudioFile(scenario.input), /HTTP 503/);
    assert.equal(scenario.cancellations(), 1);
});

test("rejected real loopback response closes the upstream transfer", async () => {
    let confirmClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
        confirmClosed = resolve;
    });
    const server = createServer((_request, response) => {
        response.on("close", () => confirmClosed?.());
        response.writeHead(503, { "Content-Type": "application/octet-stream" });
        response.write(Buffer.alloc(1024));
        // Deliberately leave a long response unfinished; cancellation must end it.
    });
    // The OS-assigned port can fall on Fetch's forbidden-port list. Use a
    // high-port range outside that list, with bounded collision retries.
    for (let attempt = 0; attempt < 16; attempt += 1) {
        const listening = once(server, "listening");
        server.listen(randomInt(20_000, 60_000), "127.0.0.1");
        try {
            await listening;
            break;
        } catch (error) {
            if (
                (error as NodeJS.ErrnoException).code !== "EADDRINUSE" ||
                attempt === 15
            ) {
                throw error;
            }
        }
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const scenario = fixture();
        scenario.input.request = async () =>
            fetch(`http://127.0.0.1:${address.port}`);
        await assert.rejects(retainDeviceAudioFile(scenario.input), /HTTP 503/);
        await Promise.race([
            closed,
            new Promise<never>((_resolve, reject) => {
                deadline = setTimeout(
                    () => reject(new Error("Upstream remained open")),
                    2000,
                );
            }),
        ]);
        assert.equal(scenario.retains(), 0);
    } finally {
        clearTimeout(deadline);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("successful retention keeps its receipt and consumes the complete response", async () => {
    const scenario = fixture();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    scenario.input.request = async () => new Response(bytes);
    const open = scenario.input.vault.open.bind(scenario.input.vault);
    let discards = 0;
    scenario.input.vault.open = async (input) => ({
        ...(await open(input)),
        async retain({ stream }) {
            const consumed = new Uint8Array(
                await new Response(stream).arrayBuffer(),
            );
            assert.deepEqual(consumed, bytes);
            return {
                ref: "opfs1:test" as DeviceAudioVaultRef,
                bytes: consumed.length,
                contentType: "audio/mpeg",
                displayName: "track.mp3",
                async discard() {
                    discards += 1;
                },
            };
        },
    });
    const retained = await retainDeviceAudioFile(scenario.input);
    assert.equal(retained.receipt.bytes, 4);
    assert.equal(discards, 0);
});
