const test = require("node:test");
const assert = require("node:assert/strict");
const contract = require("../dist/index.js");

const origins = [
    { kind: "track", source: "youtube", id: "seedVideo01" },
    { kind: "track", source: "library", id: "library-track" },
    { kind: "artist", source: "library", id: "library-artist" },
    { kind: "artist", source: "discovery", name: "Ибрагим Маалуф" },
];

test("radio origin round-trips only its bounded musical identity", () => {
    for (const origin of origins) {
        const field = "id" in origin ? "id" : "name";
        assert.deepEqual(
            contract.normalizePlaybackRadioOrigin({
                ...origin,
                [field]: ` ${origin[field]} `,
                token: "secret",
                url: "https://media.example/signed",
                extra: { id: "other" },
            }),
            origin,
        );
    }
});

test("malformed, oversized and unsupported radio origins are discarded", () => {
    for (const value of [
        null,
        [],
        "radio",
        {},
        { kind: "track", source: "youtube", id: "https://example/seed" },
        { kind: "track", source: "youtube", id: "x" },
        { kind: "track", source: "youtube", id: "x".repeat(100) },
        { kind: "track", source: "library", id: "a".repeat(129) },
        { kind: "artist", source: "discovery", name: "a".repeat(201) },
        { kind: "artist", source: "discovery", name: "Artist\nOther" },
        { kind: "artist", source: "discovery", name: "   " },
        { kind: "track", source: "vk", id: "123" },
        { kind: "artist", source: "youtube", id: "123" },
        { kind: "track", source: "library", id: ["123"] },
    ]) {
        assert.equal(contract.normalizePlaybackRadioOrigin(value), null);
    }
});

test("radio equality compares original intent rather than record object identity", () => {
    for (const origin of origins) {
        assert.equal(
            contract.playbackRadioOriginsMatch(origin, { ...origin }),
            true,
        );
        assert.equal(contract.playbackRadioOriginsMatch(origin, null), false);
    }
    assert.equal(contract.playbackRadioOriginsMatch(null, undefined), true);
    assert.equal(
        contract.playbackRadioOriginsMatch(origins[0], {
            ...origins[0],
            id: "other",
        }),
        false,
    );
    assert.equal(
        contract.playbackRadioOriginsMatch(origins[1], origins[2]),
        false,
    );
});
