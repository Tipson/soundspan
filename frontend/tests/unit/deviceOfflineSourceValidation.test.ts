import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDeviceAudioSourceUrl } from "../../features/device-offline/sourceValidation";
test("only renewable exact music identities are retained for retry", () => {
    for (const path of ["vk/1_2", "yandex/123"])
        assert.equal(
            normalizeDeviceAudioSourceUrl(
                `/api/music-sources/recordings/${path}/stream`,
                "https://soundspan.test",
            ).stored,
            `/api/music-sources/recordings/${path}/stream`,
        );
    assert.throws(() =>
        normalizeDeviceAudioSourceUrl(
            "/api/music-sources/leases/expired/stream",
            "https://soundspan.test",
        ),
    );
    assert.throws(() =>
        normalizeDeviceAudioSourceUrl(
            "/api/music-sources/recordings/yandex/1_2/stream",
            "https://soundspan.test",
        ),
    );
});

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
