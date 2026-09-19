import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(testDirectory, "../..");

test("the generated build id is also embedded in the client diagnostic bundle", () => {
    const result = spawnSync(
        process.execPath,
        [
            "--input-type=commonjs",
            "--eval",
            `
const assert = require("node:assert/strict");
const loadConfig = require("next/dist/server/config").default;
const { PHASE_PRODUCTION_BUILD } = require("next/constants");
loadConfig(PHASE_PRODUCTION_BUILD, process.cwd()).then(async (config) => {
    const id = await config.generateBuildId();
    assert.match(id, /^[a-f0-9-]{36}$/);
    assert.equal(await config.generateBuildId(), id);
    assert.equal(config.env.NEXT_PUBLIC_SOUNDSPAN_BUILD_ID, id);
    const worker = require("node:child_process").spawnSync(process.execPath,
        ["--input-type=commonjs", "--eval", 'require("next/dist/server/config").default(require("next/constants").PHASE_PRODUCTION_BUILD, process.cwd()).then(async config => console.log(JSON.stringify([await config.generateBuildId(), config.env.NEXT_PUBLIC_SOUNDSPAN_BUILD_ID])))'],
        { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 5_000 });
    assert.equal(worker.status, 0, worker.stderr);
    assert.deepEqual(JSON.parse(worker.stdout.trim()), [id, id]);
}).catch((error) => { console.error(error); process.exitCode = 1; });
`,
        ],
        {
            cwd: frontendRoot,
            encoding: "utf8",
            env: { ...process.env, ANALYZE: "false" },
            timeout: 10_000,
        },
    );
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
});

test("production config loads without the dev-only bundle analyzer", () => {
    const result = spawnSync(
        process.execPath,
        [
            "--input-type=commonjs",
            "--eval",
            `
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === "@next/bundle-analyzer") {
        const error = new Error("blocked dev-only dependency");
        error.code = "MODULE_NOT_FOUND";
        throw error;
    }
    return originalLoad.call(this, request, parent, isMain);
};
const loadConfig = require("next/dist/server/config").default;
const { PHASE_PRODUCTION_SERVER } = require("next/constants");
loadConfig(PHASE_PRODUCTION_SERVER, process.cwd())
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
`,
        ],
        {
            cwd: frontendRoot,
            encoding: "utf8",
            env: { ...process.env, ANALYZE: "false" },
            timeout: 10_000,
        },
    );

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
});

test("analysis config still loads and applies the bundle analyzer", () => {
    const result = spawnSync(
        process.execPath,
        [
            "--input-type=commonjs",
            "--eval",
            `
const Module = require("node:module");
const originalLoad = Module._load;
let analyzerLoads = 0;
Module._load = function(request, parent, isMain) {
    if (request === "@next/bundle-analyzer") {
        analyzerLoads += 1;
        return () => (config) => ({ ...config, analyzerTestMarker: true });
    }
    return originalLoad.call(this, request, parent, isMain);
};
const loadConfig = require("next/dist/server/config").default;
const { PHASE_PRODUCTION_BUILD } = require("next/constants");
loadConfig(PHASE_PRODUCTION_BUILD, process.cwd())
    .then((config) => {
        if (analyzerLoads !== 1 || config.analyzerTestMarker !== true) {
            process.exit(2);
        }
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
`,
        ],
        {
            cwd: frontendRoot,
            encoding: "utf8",
            env: { ...process.env, ANALYZE: "true" },
            timeout: 10_000,
        },
    );

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
});
