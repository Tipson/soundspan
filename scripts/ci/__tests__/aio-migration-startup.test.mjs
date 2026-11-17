import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const dockerfile = fs
    .readFileSync(path.join(repoRoot, "Dockerfile"), "utf8")
    .replaceAll("\r\n", "\n");
const begin = dockerfile.indexOf("# Run Prisma migrations\n");
const end = dockerfile.indexOf("# Stop PostgreSQL", begin);
assert.ok(begin >= 0 && end > begin, "AIO migration startup block is missing");
const startup = dockerfile.slice(begin, end);
const bashPath = (value) =>
    value
        .replaceAll("\\", "/")
        .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

function runStartup(t, options = {}) {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "soundspan-aio-migrations-"),
    );
    t.after(() => fs.rmSync(root, { recursive: true }));
    const backend = path.join(root, "backend");
    const bin = path.join(root, "bin");
    fs.mkdirSync(path.join(backend, "node_modules/.bin"), { recursive: true });
    fs.mkdirSync(path.join(backend, "prisma/migrations"), { recursive: true });
    fs.mkdirSync(bin);
    const ready = path.join(root, "schema_ready");
    const later = path.join(root, "later_services");
    const trace = path.join(root, "prisma.log");
    if (options.staleReady) fs.writeFileSync(ready, "old successful startup");
    fs.writeFileSync(
        path.join(bin, "gosu"),
        `#!/usr/bin/env bash
shift
case "$*" in
  *"table_name = '_prisma_migrations'"*) echo "$FIXTURE_HISTORY";;
  *"table_name = 'User'"*) echo "$FIXTURE_USER";;
  *"soulseekFallback"*) echo f;;
  *"SELECT 1 FROM"*) exit 0;;
  *) exit 91;;
esac
`,
        { mode: 0o700 },
    );
    fs.writeFileSync(
        path.join(backend, "node_modules/.bin/prisma"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$AIO_TRACE"
case "$*" in
  "migrate resolve --applied "*)
    if [ "$FAIL_RESOLVE" = 1 ]; then exit 17; fi
    [ "$*" = "migrate resolve --applied 20251130000000_init" ] || exit 18;;
  "migrate deploy") [ "$FAIL_DEPLOY" != 1 ] || exit 19;;
  *) exit 92;;
esac
`,
        { mode: 0o700 },
    );
    const script = path.join(root, "startup.sh");
    fs.writeFileSync(
        script,
        `#!/usr/bin/env bash\nset -e\n${startup
            .replaceAll("/app/backend", bashPath(backend))
            .replaceAll(
                "/data/.schema_ready",
                bashPath(ready),
            )}\nprintf started > '${bashPath(later)}'\n`,
    );
    const result = spawnSync(
        process.platform === "win32"
            ? "C:/Program Files/Git/bin/bash.exe"
            : "bash",
        [bashPath(script)],
        {
            encoding: "utf8",
            timeout: 10_000,
            env: {
                ...process.env,
                PATH: `${bashPath(bin)}:/usr/bin:/bin`,
                AIO_TRACE: bashPath(trace),
                FIXTURE_HISTORY: options.history ? "t" : "f",
                FIXTURE_USER: options.user === false ? "f" : "t",
                FAIL_RESOLVE: options.failResolve ? "1" : "0",
                FAIL_DEPLOY: options.failDeploy ? "1" : "0",
            },
        },
    );
    assert.ifError(result.error);
    return {
        ...result,
        ready: fs.existsSync(ready),
        later: fs.existsSync(later),
        calls: fs.existsSync(trace)
            ? fs.readFileSync(trace, "utf8").trim().split("\n")
            : [],
    };
}

test("legacy AIO resolves the real init before deploy without executing init twice", (t) => {
    const result = runStartup(t);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.calls, [
        "migrate resolve --applied 20251130000000_init",
        "migrate deploy",
    ]);
    assert.equal(result.ready, true);
    assert.equal(result.later, true);
});

test("failed legacy resolve stops before deploy, schema readiness and later services", (t) => {
    const result = runStartup(t, { failResolve: true, staleReady: true });
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 1);
    assert.equal(result.ready, false);
    assert.equal(result.later, false);
});

for (const history of [false, true]) {
    test(`failed deploy stops ${history ? "ordinary" : "legacy"} AIO startup`, (t) => {
        const result = runStartup(t, {
            history,
            failDeploy: true,
            staleReady: true,
        });
        assert.notEqual(result.status, 0);
        assert.equal(result.ready, false);
        assert.equal(result.later, false);
    });
}

test("ordinary migrated AIO deploys without baseline repair", (t) => {
    const result = runStartup(t, { history: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.calls, ["migrate deploy"]);
    assert.equal(result.ready, true);
    assert.equal(result.later, true);
});

test("fresh AIO deploys without resolving an existing init", (t) => {
    const result = runStartup(t, { user: false });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.calls, ["migrate deploy"]);
    assert.equal(result.ready, true);
    assert.equal(result.later, true);
});
