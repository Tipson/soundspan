import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("split env renderer preserves tuning, secrets, and isolated rehearsal endpoints", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "soundspan-split-env-"));
    const aioInspect = path.join(directory, "aio.json");
    const ytmusicInspect = path.join(directory, "ytmusic.json");
    const baseEnv = path.join(directory, "base.env");
    const output = path.join(directory, "split.env");
    writeFileSync(
        aioInspect,
        JSON.stringify([
            { Config: { Env: ["DATABASE_URL=stale", "LOG_LEVEL=info"] } },
        ]),
    );
    writeFileSync(
        ytmusicInspect,
        JSON.stringify([
            {
                Config: {
                    Env: [
                        "YTMUSIC_SPOOL_TIMEOUT=125",
                        "INTERNAL_API_SECRET=stale",
                    ],
                },
            },
        ]),
    );
    writeFileSync(
        baseEnv,
        "INTERNAL_API_SECRET=stable-secret\nPOSTGRES_PASSWORD=stable-password\n",
    );

    const python = process.platform === "win32" ? "py" : "python3";
    const pythonArgs = process.platform === "win32" ? ["-3"] : [];
    const result = spawnSync(
        python,
        [
            ...pythonArgs,
            "scripts/deploy/render-split-env.py",
            "--mode",
            "rehearsal",
            "--base-env",
            baseEnv,
            "--aio-inspect",
            aioInspect,
            "--ytmusic-inspect",
            ytmusicInspect,
            "--output",
            output,
            "--image-repository",
            "ghcr.io/example/soundspan",
            "--image-tag",
            "main-deadbee",
            "--production-bind-ip",
            "192.0.2.10",
            "--music-path",
            "/srv/music/library",
            "--analysis-spool-path",
            "/srv/music/spool",
            "--music-volume-marker-path",
            "/srv/music/.marker",
            "--tidal-data-path",
            "/opt/tidal",
            "--ytmusic-data-path",
            "/opt/ytmusic-rehearsal",
        ],
        { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const rendered = readFileSync(output, "utf8");
    assert.match(rendered, /YTMUSIC_SPOOL_TIMEOUT="125"/);
    assert.match(rendered, /INTERNAL_API_SECRET=stable-secret/);
    assert.doesNotMatch(rendered, /DATABASE_URL=stale/);
    assert.doesNotMatch(rendered, /INTERNAL_API_SECRET="stale"/);
    assert.match(rendered, /FRONTEND_PORT="13030"/);
    assert.match(rendered, /SOUNDSPAN_BIND_IP="127\.0\.0\.1"/);
    assert.match(rendered, /YTMUSIC_DATA_PATH="\/opt\/ytmusic-rehearsal"/);
});
