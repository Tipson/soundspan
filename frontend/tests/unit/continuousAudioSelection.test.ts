import assert from "node:assert/strict";
import test from "node:test";
import { supportsContinuousAndroidPlayback } from "../../lib/audio-engine/continuousAudioSelection";

test("continuous local playback requires Android and supported native MediaSource operations", () => {
    const supported = {
        userAgent: "Mozilla/5.0 (Linux; Android 10) Chrome/153.0 Mobile Safari",
        mediaSource: true,
        changeType: true,
        audioType: true,
    };
    assert.equal(supportsContinuousAndroidPlayback(supported), true);
    for (const field of ["mediaSource", "changeType", "audioType"])
        assert.equal(
            supportsContinuousAndroidPlayback({ ...supported, [field]: false }),
            false,
        );
    for (const userAgent of [
        "Mozilla/5.0 (iPhone) Safari",
        "Mozilla/5.0 (Windows NT 10.0) Chrome/153.0",
        "",
    ])
        assert.equal(
            supportsContinuousAndroidPlayback({ ...supported, userAgent }),
            false,
        );
});
