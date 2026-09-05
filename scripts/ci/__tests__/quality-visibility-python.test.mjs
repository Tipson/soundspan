import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const workflow = fs.readFileSync(
    path.join(repoRoot, ".github/workflows/quality-visibility.yml"),
    "utf8",
);

function jobBlock(jobName) {
    const startPattern = new RegExp(`^  ${jobName}:\\s*$`, "m");
    const startMatch = startPattern.exec(workflow);
    assert.ok(startMatch, `missing ${jobName} job`);

    const remainder = workflow.slice(startMatch.index + startMatch[0].length);
    const nextJobOffset = remainder.search(/^  [a-z0-9-]+:\s*$/m);
    return nextJobOffset === -1 ? remainder : remainder.slice(0, nextJobOffset);
}

test("python quality uses the dependency-compatible runner without weakening checks", () => {
    const block = jobBlock("python-quality");

    assert.match(block, /python-version: "3\.12"/);
    assert.doesNotMatch(block, /continue-on-error:/);

    for (const requirementsPath of [
        "services/requirements-quality.txt",
        "services/audio-analyzer/requirements-test.txt",
        "services/vibe-provider-dclap/requirements-test.txt",
        "services/ytmusic-streamer/requirements-test.txt",
    ]) {
        assert.match(
            block,
            new RegExp(`-r ${requirementsPath.replaceAll("/", "\\/")}`),
        );
    }

    for (const command of [
        "pytest tests/ -q",
        "pytest services/common/tests -q",
        "ruff check services/",
        "ruff format --check services/",
        "MYPYPATH=. mypy",
    ]) {
        assert.match(
            block,
            new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
    }
});

test("local Python verification includes shared sidecar runtime tests", () => {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    assert.match(
        manifest.scripts["verify:python"],
        /(?:^|&&\s*)pytest services\/common\/tests -q(?:\s*&&|$)/,
    );
});

test("the ytmusic runtime sidecar remains tested on Python 3.14", () => {
    const block = jobBlock("python-sidecar-tests");

    assert.match(
        block,
        /- service: ytmusic-streamer\r?\n\s+python-version: "3\.14"/,
    );
});
