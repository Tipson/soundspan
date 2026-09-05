import assert from "node:assert/strict";
import { test } from "node:test";
import { runFormatChecks } from "../check-format.mjs";

test("runs every package and root formatter without shell interpretation", () => {
    const calls = [];
    const result = runFormatChecks({
        npmCli: "C:/Program Files/nodejs/npm-cli.js",
        run: (...args) => {
            calls.push(args);
            return { status: 0 };
        },
    });
    assert.equal(result, 0);
    assert.equal(calls.length, 4);
    assert.deepEqual(
        calls.slice(0, 3).map(([, args]) => args.slice(1)),
        [
            [
                "--prefix",
                "packages/media-metadata-contract",
                "run",
                "format:check",
            ],
            ["--prefix", "backend", "run", "format:check"],
            ["--prefix", "frontend", "run", "format:check"],
        ],
    );
    for (const [command, , options] of calls) {
        assert.equal(command, process.execPath);
        assert.equal(options.shell, false);
    }
    assert.equal(calls[0][1][0], "C:/Program Files/nodejs/npm-cli.js");
    assert.ok(calls[3][1].includes("--check"));
});

test("keeps all formatting failures visible and fails the aggregate gate", () => {
    for (const failure of [
        { status: 1 },
        { status: null },
        { error: new Error("failed to spawn") },
    ]) {
        let attempts = 0;
        const result = runFormatChecks({
            npmCli: "/npm-cli.js",
            run: () => (++attempts === 1 ? failure : { status: 0 }),
        });
        assert.equal(result, 1);
        assert.equal(attempts, 4);
    }
});

test("reports missing npm runtime rather than silently skipping package checks", () => {
    assert.throws(
        () => runFormatChecks({ npmCli: "" }),
        /npm run format:check/,
    );
});
