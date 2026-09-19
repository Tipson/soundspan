import assert from "node:assert/strict";
import test from "node:test";
import {
    detectContinuousAudioMime,
    prepareContinuousAudioSource,
} from "../../lib/audio-engine/continuousAudioSource";

test("container detection distinguishes MP3, ADTS AAC and unsupported bytes", () => {
    assert.equal(
        detectContinuousAudioMime(new Uint8Array([73, 68, 51, 4])),
        "audio/mpeg",
    );
    assert.equal(
        detectContinuousAudioMime(new Uint8Array([255, 251, 144, 0])),
        "audio/mpeg",
    );
    assert.equal(
        detectContinuousAudioMime(new Uint8Array([255, 241, 80, 0])),
        "audio/aac",
    );
    assert.equal(
        detectContinuousAudioMime(new TextEncoder().encode("not audio")),
        null,
    );
});

test("only local blob sources may be read by the continuous offline transport", async () => {
    let fetched = false;
    const result = await prepareContinuousAudioSource(
        { url: "https://example.com/audio" },
        new AbortController().signal,
        {
            readBlob: async () => {
                fetched = true;
                return new Blob();
            },
            duration: async () => 10,
            supports: () => true,
        },
    );
    assert.equal(result, null);
    assert.equal(fetched, false);
});

test("actual bytes determine compatibility, rather than a claimed file type", async () => {
    const result = await prepareContinuousAudioSource(
        { url: "blob:local", mimeType: "audio/webm" },
        new AbortController().signal,
        {
            readBlob: async () =>
                new Blob([new Uint8Array([73, 68, 51, 4])], {
                    type: "audio/webm",
                }),
            duration: async () => 30,
            supports: (mime) => mime === "audio/mpeg",
        },
    );
    assert.equal(result?.mime, "audio/mpeg");
    assert.equal(result?.durationSec, 30);
});

test("cancellation during local reading prevents metadata work and adoption", async () => {
    const controller = new AbortController();
    let metadata = false;
    await assert.rejects(
        prepareContinuousAudioSource({ url: "blob:local" }, controller.signal, {
            readBlob: async () => {
                controller.abort();
                return new Blob([new Uint8Array([73, 68, 51, 4])]);
            },
            duration: async () => {
                metadata = true;
                return 10;
            },
            supports: () => true,
        }),
        { name: "AbortError" },
    );
    assert.equal(metadata, false);
});

test("invalid duration and unsupported containers fail closed to the native fallback", async () => {
    for (const seconds of [NaN, Infinity, 0, -1]) {
        const result = await prepareContinuousAudioSource(
            { url: "blob:local" },
            new AbortController().signal,
            {
                readBlob: async () =>
                    new Blob([new Uint8Array([73, 68, 51, 4])]),
                duration: async () => seconds,
                supports: () => true,
            },
        );
        assert.equal(result, null);
    }
});
