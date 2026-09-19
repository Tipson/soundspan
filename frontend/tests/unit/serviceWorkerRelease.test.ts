import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("release worker fails without its imported asset and evaluates with the complete bundle", () => {
    const directory = mkdtempSync(join(tmpdir(), "soundspan-worker-release-"));
    const script = fileURLToPath(
        new URL(
            "../../scripts/check-service-worker-runtime.mjs",
            import.meta.url,
        ),
    );
    const run = () =>
        spawnSync(process.execPath, [script, directory], {
            encoding: "utf8",
            timeout: 5000,
        });
    try {
        copyFileSync(
            new URL("../../public/sw.js", import.meta.url),
            join(directory, "sw.js"),
        );
        const missing = run();
        assert.equal(missing.status, 1);
        assert.match(missing.stderr, /stream-preload-cache\.js/);
        copyFileSync(
            new URL("../../public/stream-preload-cache.js", import.meta.url),
            join(directory, "stream-preload-cache.js"),
        );
        const complete = run();
        assert.equal(complete.status, 0, complete.stderr);
        assert.match(complete.stdout, /Service worker runtime verified/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
