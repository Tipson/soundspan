import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { api } from "@/lib/api";

test("quality badge API requests cache-only metadata", async () => {
    const paths: string[] = [];
    const stub = mock.method(api, "get", async (path: string) => {
        paths.push(path);
        return { abr: 0, acodec: "" };
    });
    try {
        await api.getYtMusicStreamInfo("dQw4w9WgXcQ", "HIGH", { cachedOnly: true });
        assert.equal(paths[0], "/ytmusic/stream-info-public/dQw4w9WgXcQ?quality=HIGH&cachedOnly=true");
    } finally {
        stub.mock.restore();
    }
});
