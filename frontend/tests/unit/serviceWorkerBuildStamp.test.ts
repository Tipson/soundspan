import assert from "node:assert/strict";
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("each frontend build changes worker bytes without changing its runtime or accumulating stamps", () => {
    const directory = mkdtempSync(join(tmpdir(), "soundspan-worker-stamp-"));
    const script = fileURLToPath(
        new URL(
            "../../scripts/stamp-service-worker-build.mjs",
            import.meta.url,
        ),
    );
    try {
        mkdirSync(join(directory, "public"));
        mkdirSync(join(directory, ".next"));
        const worker = join(directory, "public/sw.js");
        const build = join(directory, ".next/BUILD_ID");
        writeFileSync(worker, "globalThis.result = 42;\n");
        const run = () =>
            spawnSync(process.execPath, [script], {
                cwd: directory,
                encoding: "utf8",
            });
        assert.notEqual(run().status, 0, "missing build must fail closed");
        writeFileSync(build, "build-a");
        assert.equal(run().status, 0);
        const first = readFileSync(worker, "utf8");
        assert.equal(run().status, 0);
        assert.equal(readFileSync(worker, "utf8"), first);
        writeFileSync(build, "build-b");
        assert.equal(run().status, 0);
        const second = readFileSync(worker, "utf8");
        assert.notEqual(second, first);
        assert.equal(second.length, first.length);
        assert.equal(
            new Function(`${second}\nreturn globalThis.result;`)(),
            42,
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
