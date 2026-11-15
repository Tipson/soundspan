import sharp from "sharp";
import { constants as zlibConstants } from "node:zlib";

describe("installed security runtime", () => {
    it("uses the patched sharp decoder", () => {
        const version = sharp.versions.sharp.split(".").map(Number);
        const [major = 0, minor = 0, patch = 0] = version;
        expect(major > 0 || minor > 35 || (minor === 35 && patch >= 5)).toBe(
            true,
        );
    });

    it("includes the permanent Brotli block-switch error fix", () => {
        // The upstream backport may retain the old Brotli version string.
        expect(
            "BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH" in zlibConstants,
        ).toBe(true);
    });
});
