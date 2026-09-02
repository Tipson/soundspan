import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPlaybackError } from "../../lib/audio-engine/playbackErrorCategory";

test("classifies provider and transport playback failures", () => {
    assert.equal(
        classifyPlaybackError(new DOMException("Aborted", "AbortError")),
        "client_abort",
    );
    assert.equal(
        classifyPlaybackError(new Error("HTTP 429 rate limit")),
        "rate_limit",
    );
    assert.equal(
        classifyPlaybackError(new Error("upstream timeout 504")),
        "timeout",
    );
    assert.equal(
        classifyPlaybackError(new Error("MEDIA_ERR_NETWORK")),
        "network",
    );
    assert.equal(
        classifyPlaybackError(new Error("stream not found 404")),
        "unavailable",
    );
    assert.equal(
        classifyPlaybackError(new Error("provider_challenge")),
        "provider_challenge",
    );
    assert.equal(
        classifyPlaybackError(new Error("MEDIA_ERR_SRC_NOT_SUPPORTED")),
        "unsupported_source",
    );
});
