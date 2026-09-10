import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../../lib/api";

test("local device reads retain bytes and content type without server access", async () => {
    const url = URL.createObjectURL(
        new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }),
    );
    try {
        const response = await api.readLocalDeviceFile(
            url,
            new AbortController().signal,
        );
        assert.equal(response.headers.get("content-type"), "audio/mpeg");
        assert.deepEqual(
            new Uint8Array(await response.arrayBuffer()),
            new Uint8Array([1, 2, 3]),
        );
    } finally {
        URL.revokeObjectURL(url);
    }
});

test("local device reads reject remote URLs and cancelled ownership", async () => {
    await assert.rejects(
        api.readLocalDeviceFile(
            "https://example.test/audio",
            new AbortController().signal,
        ),
        /local device file/,
    );
    const controller = new AbortController();
    controller.abort(new Error("account changed"));
    await assert.rejects(
        api.readLocalDeviceFile("blob:unused", controller.signal),
        /account changed/,
    );
});
