import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeWaveMood } from "../../lib/waveSelection";
test("retired mood settings map to visible choices without a hidden filter", () => {
    for (const [input, expected] of [
        ["focus", "calm"],
        ["workout", "energetic"],
        ["favorites", null],
        ["forgotten", null],
        ["calm", "calm"],
        ["energetic", "energetic"],
        [null, null],
        ["unknown", null],
    ] as const)
        assert.equal(normalizeWaveMood(input), expected);
});
