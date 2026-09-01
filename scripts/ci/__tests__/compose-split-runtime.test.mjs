import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("split PostgreSQL wrapper forwards an explicit server command", async () => {
    const compose = await readFile(
        path.join(repoRoot, "docker-compose.yml"),
        "utf8",
    );
    const postgresBlock = compose.match(
        /^    postgres:\s*$([\s\S]*?)(?=^    redis:\s*$)/m,
    )?.[1];

    assert.ok(postgresBlock, "postgres service is missing");
    assert.match(postgresBlock, /exec docker-entrypoint\.sh "\$\$@"/);
    assert.match(
        postgresBlock,
        /^        command: \["postgres"\]\s*$/m,
        "the shell wrapper otherwise receives an empty argv and exits",
    );
});

test("prebuilt overlay covers every buildable split service", async () => {
    const overlay = await readFile(
        path.join(repoRoot, "docker-compose.images.yml"),
        "utf8",
    );
    for (const service of [
        "backend",
        "backend-worker",
        "frontend",
        "audio-analyzer",
        "vibe-provider-dclap",
        "tidal-streamer",
        "ytmusic-streamer",
    ]) {
        assert.match(
            overlay,
            new RegExp(`^    ${service}:\\s*$`, "m"),
            `${service} needs an immutable image override`,
        );
    }
});

test("prebuilt split API cannot duplicate worker processors", async () => {
    const overlay = await readFile(
        path.join(repoRoot, "docker-compose.images.yml"),
        "utf8",
    );
    const backendBlock = overlay.match(
        /^    backend:\s*$([\s\S]*?)(?=^    backend-worker:\s*$)/m,
    )?.[1];

    assert.ok(backendBlock, "backend image override is missing");
    assert.match(
        backendBlock,
        /^            BACKEND_PROCESS_ROLE: api\s*$/m,
        "API and worker images would otherwise both process background jobs",
    );
});
