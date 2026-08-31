import assert from "node:assert/strict";
import test from "node:test";
import {
    getNextTrackInfo,
    isLikelyTransientStreamError,
    isProviderStartupFailure,
    resolveAudioLoadTimeoutPolicy,
    resolveDirectTrackSourceType,
    shouldAttemptOuterTransientRecovery,
} from "../../lib/audio-engine/audioPlaybackTrackPolicy";

test("selects the next music track in queue order", () => {
    const nextTrack = getNextTrackInfo(
        [{ id: "first" }, { id: "second" }],
        0,
        false,
        [],
        "off",
    );

    assert.equal(nextTrack?.id, "second");
});

test("does not preload a podcast episode from a mixed-media queue", () => {
    const nextTrack = getNextTrackInfo(
        [{ id: "track" }, { id: "episode", itemType: "episode" }],
        0,
        false,
        [],
        "off",
    );

    assert.equal(nextTrack, null);
});

test("wraps a shuffled queue only for repeat-all playback", () => {
    const queue = [{ id: "first" }, { id: "second" }];

    assert.equal(getNextTrackInfo(queue, 0, true, [1, 0], "off"), null);
    assert.equal(getNextTrackInfo(queue, 0, true, [1, 0], "all")?.id, "second");
});

test("classifies bounded transport failures as transient", () => {
    assert.equal(
        isLikelyTransientStreamError(new Error("network timeout")),
        true,
    );
    assert.equal(
        isLikelyTransientStreamError(new Error("decode failed")),
        false,
    );
});

test("does not restart outer recovery after the engine exhausts its budget", () => {
    assert.equal(
        shouldAttemptOuterTransientRecovery({
            error: new Error("MEDIA_ERR_NETWORK"),
            recoverable: false,
        }),
        false,
    );
    assert.equal(
        shouldAttemptOuterTransientRecovery({
            error: new Error("network timeout"),
        }),
        true,
    );
});

test("classifies a YouTube source rejection as a temporary provider startup failure", () => {
    assert.equal(
        isProviderStartupFailure({
            track: { streamSource: "youtube" },
            code: "4",
            error: new Error("MEDIA_ERR_SRC_NOT_SUPPORTED"),
        }),
        false,
    );
    assert.equal(
        isProviderStartupFailure({
            track: { streamSource: "youtube" },
            code: "4",
            error: new Error("MEDIA_ERR_SRC_NOT_SUPPORTED"),
            priorConsecutiveErrors: 1,
        }),
        true,
    );
    assert.equal(
        isProviderStartupFailure({
            track: { streamSource: "local" },
            code: "4",
            error: new Error("MEDIA_ERR_SRC_NOT_SUPPORTED"),
        }),
        false,
    );
});

test("provider tracks outlive the backend and frontend first-byte budgets", () => {
    assert.deepEqual(
        resolveAudioLoadTimeoutPolicy("track", {
            streamSource: "youtube",
        }),
        { timeoutMs: 135_000, maxRetries: 0 },
    );
    assert.deepEqual(
        resolveAudioLoadTimeoutPolicy("track", {
            streamSource: "youtube-direct",
        }),
        { timeoutMs: 135_000, maxRetries: 0 },
    );
});

test("local and non-track media retain the regular load retry window", () => {
    assert.deepEqual(
        resolveAudioLoadTimeoutPolicy("track", { streamSource: "local" }),
        { timeoutMs: 20_000, maxRetries: 1 },
    );
    assert.deepEqual(
        resolveAudioLoadTimeoutPolicy("podcast", {
            streamSource: "youtube",
        }),
        { timeoutMs: 20_000, maxRetries: 1 },
    );
});

test("a ready device-offline copy does not inherit the provider spool wait", () => {
    assert.deepEqual(
        resolveAudioLoadTimeoutPolicy(
            "track",
            { streamSource: "youtube" },
            "/__offline/audio/opaque-key",
        ),
        { timeoutMs: 20_000, maxRetries: 1 },
    );
});

test("resolves peer tracks to the peer engine source type", () => {
    assert.equal(
        resolveDirectTrackSourceType({ streamSource: "peer" }),
        "peer",
    );
    assert.equal(resolveDirectTrackSourceType({}), "local");
    assert.equal(
        resolveDirectTrackSourceType({
            streamSource: "tidal",
            tidalTrackId: 42,
        }),
        "tidal",
    );
});
