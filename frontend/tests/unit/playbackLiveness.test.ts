import assert from "node:assert/strict";
import test from "node:test";
import {
    clearPlaybackHeartbeat,
    hasFreshPlaybackHeartbeat,
    markPlaybackHeartbeat,
} from "../../lib/audio/playback-liveness";

test("playback liveness expires and never accepts a future timestamp", () => {
    clearPlaybackHeartbeat();
    assert.equal(hasFreshPlaybackHeartbeat(1_000), false);

    markPlaybackHeartbeat(1_000);
    assert.equal(hasFreshPlaybackHeartbeat(1_000), true);
    assert.equal(hasFreshPlaybackHeartbeat(16_000), true);
    assert.equal(hasFreshPlaybackHeartbeat(16_001), false);
    assert.equal(hasFreshPlaybackHeartbeat(999), false);

    clearPlaybackHeartbeat();
    assert.equal(hasFreshPlaybackHeartbeat(1_000), false);
});
