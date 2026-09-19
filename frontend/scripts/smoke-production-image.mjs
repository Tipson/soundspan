import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const image = process.argv[2];
assert.ok(image, "Usage: node scripts/smoke-production-image.mjs IMAGE");
const docker = (...args) =>
    execFileSync("docker", args, {
        encoding: "utf8",
        timeout: 60_000,
    }).trim();
const id = docker("run", "-d", "-p", "127.0.0.1::3030", image);
try {
    docker(
        "exec",
        id,
        "node",
        "-e",
        `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        assert.notEqual(process.getuid(), 0);
        for (const path of ['.next/cache', 'node_modules/typescript',
            'node_modules/happy-dom', 'node_modules/eslint', 'node_modules/date-fns']) {
            assert.equal(fs.existsSync('/app/' + path), false, path + ' is build-only');
        }
        for (const name of ['next', 'react', 'http-proxy-middleware',
            '@soundspan/media-metadata-contract']) require(name);
    `,
    );
    const info = JSON.parse(docker("inspect", id))[0];
    const port = info.NetworkSettings.Ports["3030/tcp"][0].HostPort;
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            const response = await fetch(`${base}/health/ready`, {
                signal: AbortSignal.timeout(1000),
            });
            if (response.ok) {
                ready = true;
                break;
            }
        } catch {
            /* The container may still be starting. */
        }
        await delay(500);
    }
    assert.ok(ready, "Container becomes ready");
    for (const path of [
        "/login",
        "/library",
        "/vibe",
        "/runtime-config",
        "/sw.js",
    ]) {
        const response = await fetch(base + path, {
            signal: AbortSignal.timeout(10_000),
        });
        assert.equal(response.status, 200, path);
        const body = await response.text();
        assert.ok(body.length > 0, path);
        if (path === "/login") {
            const asset = body.match(
                /src="([^\"]*\/_next\/static\/[^\"]+\.js)"/,
            );
            assert.ok(asset, "Login references a production JS bundle");
            const js = await fetch(new URL(asset[1], base));
            assert.equal(js.status, 200, "Production bundle is served");
            assert.match(js.headers.get("cache-control"), /immutable/);
        }
    }
    const unavailable = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(10_000),
    });
    assert.equal(unavailable.status, 503, "Proxy handles unavailable backend");
    assert.equal((await unavailable.json()).code, "API_PROXY_UNAVAILABLE");
    docker("stop", "--time", "15", id);
    assert.equal(JSON.parse(docker("inspect", id))[0].State.ExitCode, 0);
    console.log(
        "verify: production image smoke PASS (lean runtime, routes, assets, proxy failure, SIGTERM)",
    );
} catch (error) {
    console.error(docker("logs", "--tail", "30", id));
    throw error;
} finally {
    docker("rm", "-f", id);
}
