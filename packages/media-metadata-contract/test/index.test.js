const test = require("node:test");
const assert = require("node:assert/strict");

const contract = require("../dist/index.js");
for (const source of ["vk", "yandex"]) {
    test(`${source} preserves exact provider identity through canonical normalization`, () => {
        assert.equal(contract.normalizeCanonicalMediaSource(source), source);
        assert.deepEqual(
            contract.normalizeCanonicalMediaProviderIdentity({
                streamSource: source,
                providerTrackId: "123",
            }),
            { source, providerTrackId: "123" },
        );
        assert.deepEqual(contract.toLegacyStreamFields({ source }), {
            streamSource: source,
        });
        assert.equal(contract.toAudioEngineSourceType(source), source);
    });
}

test("peer is a canonical media source and audio-engine source", () => {
    assert.equal(contract.CANONICAL_MEDIA_SOURCE_VALUES.includes("peer"), true);
    assert.equal(contract.normalizeCanonicalMediaSource("peer"), "peer");
    assert.equal(contract.toAudioEngineSourceType("peer"), "peer");
});

test("peer legacy stream fields remain a playback-only concern", () => {
    assert.deepEqual(contract.toLegacyStreamFields({ source: "peer" }), {
        streamSource: "peer",
    });
});
