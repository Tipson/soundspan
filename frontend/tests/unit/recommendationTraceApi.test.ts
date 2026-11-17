import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { api } from "../../lib/api";

test("admin trace uses exact query identity and a private bounded cancelable request", async () => {
    const response = { available: false, generationId: "generation_1" };
    const request = mock.method(api, "request", async () => response);
    const controller = new AbortController();
    try {
        assert.deepEqual(
            await api.getAdminRecommendationTrace(
                "owner-1",
                "generation_1",
                controller.signal,
            ),
            response,
        );
        const [path, options] = request.mock.calls[0].arguments;
        const url = new URL(String(path), "https://soundspan.test");
        assert.equal(url.pathname, "/admin/recommendation-trace");
        assert.deepEqual(
            [...url.searchParams],
            [
                ["userId", "owner-1"],
                ["generationId", "generation_1"],
            ],
        );
        assert.equal(options?.method, "GET");
        assert.equal(options?.cache, "no-store");
        assert.equal(options?.timeoutMs, 10_000);
        assert.equal(options?.retryOnTimeout, false);
        assert.equal(options?.silent404, true);
        assert.equal(options?.signal, controller.signal);
    } finally {
        request.mock.restore();
    }
});

test("admin trace rejects invalid identifiers without invoking the request boundary", async () => {
    const request = mock.method(api, "request", async () => ({}));
    try {
        for (const id of ["", "owner/other", "владелец", "a".repeat(129)]) {
            await assert.rejects(() =>
                api.getAdminRecommendationTrace(id, "generation-1"),
            );
            await assert.rejects(() =>
                api.getAdminRecommendationTrace("owner-1", id),
            );
        }
        assert.equal(request.mock.callCount(), 0);
    } finally {
        request.mock.restore();
    }
});
