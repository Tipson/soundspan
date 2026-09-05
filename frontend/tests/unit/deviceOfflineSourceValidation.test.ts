import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDeviceAudioSourceUrl } from "../../features/device-offline/sourceValidation";

test("device downloads accept active YouTube Music stream routes", () => {
    assert.deepEqual(
        normalizeDeviceAudioSourceUrl(
            "/api/ytmusic/stream-public/video-1?quality=HIGH",
            "https://soundspan.test",
        ),
        {
            absolute:
                "https://soundspan.test/api/ytmusic/stream-public/video-1?quality=HIGH",
            stored: "/api/ytmusic/stream-public/video-1?quality=HIGH",
        },
    );
});

test("device downloads reject retired TIDAL stream routes", () => {
    assert.throws(
        () =>
            normalizeDeviceAudioSourceUrl(
                "/api/tidal-streaming/stream/12345",
                "https://soundspan.test",
            ),
        /не относится к разрешённому аудиомаршруту/,
    );
});
