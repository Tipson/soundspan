import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { constants as zlibConstants } from "node:zlib";

const require = createRequire(import.meta.url);

function releaseAtLeast(actual: string, minimum: readonly number[]): boolean {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:$|[+-])/.exec(actual);
    assert.ok(match, `Expected a release version, received ${actual}`);
    for (let index = 0; index < 3; index += 1) {
        const value = Number(match[index + 1]);
        const floor = minimum[index];
        assert.ok(Number.isFinite(value) && floor !== undefined);
        if (value !== floor) return value > floor;
    }
    return true;
}

test("installed Next runtime includes the reviewed security fixes", () => {
    const metadata: unknown = require("next/package.json");
    assert.ok(metadata !== null && typeof metadata === "object");
    assert.ok("version" in metadata && typeof metadata.version === "string");
    assert.ok(
        releaseAtLeast(metadata.version, [16, 4, 5]),
        `Installed Next ${metadata.version} predates the reviewed security baseline`,
    );
});

test("resolved image optimizer uses the patched sharp library", () => {
    const sharp: unknown = require("sharp");
    assert.ok(typeof sharp === "function");
    assert.ok("versions" in sharp);
    const versions = sharp.versions;
    assert.ok(versions !== null && typeof versions === "object");
    assert.ok("sharp" in versions && typeof versions.sharp === "string");
    assert.ok(
        releaseAtLeast(versions.sharp, [0, 35, 5]),
        `Resolved sharp ${versions.sharp} lacks the reviewed image decoder fix`,
    );
});

test("Node Brotli decoder exposes the upstream permanent-error fix", () => {
    // Maintainers recommend this non-offensive feature check: the backport can
    // retain an older process.versions.brotli string after the fix is applied.
    assert.ok(
        "BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH" in zlibConstants,
        "Node Brotli decoder lacks the upstream permanent block-switch error",
    );
    assert.equal(
        typeof zlibConstants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH,
        "number",
    );
});
