import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { api } from "../../lib/api";

test("radio API boundary forwards strict mixed-source exclusions and existing timeout policy", async () => {
    const response = {
        tracks: [],
        radioOrigin: { kind: "artist", source: "library", id: "artist-seed" },
        generationId: "generation-1",
        nextCursor: 7,
        degraded: false,
        degradedSources: [],
    };
    const request = mock.method(api, "request", async () => response);
    try {
        const actual = await api.getRadioContinuation({
            origin: { kind: "artist", source: "library", id: "artist-seed" },
            queue: [
                { id: "local-song" },
                { id: "radio:AAAAAAAAAAA", youtubeVideoId: "AAAAAAAAAAA" },
            ],
            cursor: 6,
            limit: 25,
            sessionId: "session-1",
        });
        assert.equal(actual, response);
        const [path, options] = request.mock.calls[0].arguments as [
            string,
            { timeoutMs: number; retryOnTimeout: boolean },
        ];
        const url = new URL(path, "https://fixture.test");
        assert.equal(url.pathname, "/personalized/radio");
        assert.equal(url.searchParams.get("type"), "artist");
        assert.equal(url.searchParams.get("value"), "artist-seed");
        assert.deepEqual(url.searchParams.get("exclude")!.split(","), [
            "library:local-song",
            "yt:AAAAAAAAAAA",
        ]);
        assert.equal(url.searchParams.get("cursor"), "6");
        assert.equal(url.searchParams.get("sessionId"), "session-1");
        assert.deepEqual(options, { timeoutMs: 17000, retryOnTimeout: false });
    } finally {
        request.mock.restore();
    }
});

test("radio API rejects invalid origin before making any request", async () => {
    const request = mock.method(api, "request", async () => ({}));
    try {
        await assert.rejects(
            api.getRadioContinuation({
                origin: { kind: "track", source: "youtube", id: "invalid" },
                queue: [],
                cursor: 0,
                limit: 25,
                sessionId: "session-1",
            }),
        );
        assert.equal(request.mock.callCount(), 0);
    } finally {
        request.mock.restore();
    }
});
