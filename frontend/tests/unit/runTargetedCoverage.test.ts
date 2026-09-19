import assert from "node:assert/strict";
import test from "node:test";
import { runTargetedCoverage } from "../../scripts/run-targeted-coverage.mjs";

interface FakeResult {
    status: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
}

const passingUnitOutput = ["ℹ tests 1492", "ℹ pass 1492", "ℹ fail 0"].join(
    "\n",
);

function sink() {
    let output = "";
    return {
        stream: {
            write(value: string) {
                output += value;
                return true;
            },
        },
        read: () => output,
    };
}

function runWith(results: FakeResult[]) {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const stdout = sink();
    const stderr = sink();
    const spawn = (command: string, args: readonly string[]) => {
        calls.push({ command, args });
        const result = results.shift();
        assert.ok(result, "unexpected child process invocation");
        return result;
    };
    const status = runTargetedCoverage({
        cwd: "C:\\frontend",
        execPath: "node",
        npmExecPath: "npm-cli.js",
        spawn: spawn as unknown as typeof import("node:child_process").spawnSync,
        stdout: stdout.stream as unknown as typeof process.stdout,
        stderr: stderr.stream as unknown as typeof process.stderr,
    });

    return { calls, status, stdout: stdout.read(), stderr: stderr.read() };
}

test("coverage runner requires the complete unit phase before native coverage", () => {
    const result = runWith([
        { status: 0, stdout: passingUnitOutput },
        { status: 0, stdout: "native output" },
        { status: 0, stdout: "checker passed" },
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.calls.length, 3);
    assert.deepEqual(result.calls[0]?.args, ["npm-cli.js", "run", "test:unit"]);
    assert.deepEqual(result.calls[1]?.args, [
        "npm-cli.js",
        "run",
        "test:coverage:raw",
    ]);
    assert.match(result.stdout, /tests 1492/);
    assert.match(result.stdout, /checker passed/);
});

test("coverage runner preserves a failing unit exit code and stops", () => {
    const result = runWith([
        { status: 7, stdout: "ℹ fail 1", stderr: "unit failed" },
    ]);

    assert.equal(result.status, 7);
    assert.equal(result.calls.length, 1);
    assert.match(result.stderr, /unit failed/);
});

test("coverage runner rejects a non-passing unit summary even with exit zero", () => {
    const result = runWith([{ status: 0, stdout: "ℹ fail 1" }]);

    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 1);
    assert.match(result.stderr, /unit test summary was not passing/);
});

test("coverage runner rejects a missing unit summary", () => {
    const result = runWith([{ status: 0, stdout: "tests ended early" }]);

    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 1);
    assert.match(result.stderr, /unit test summary was not passing/);
});

test("coverage runner preserves a native hook failure even if checker accepts output", () => {
    const result = runWith([
        { status: 0, stdout: passingUnitOutput },
        { status: 9, stderr: "hook failed" },
        { status: 0, stdout: "checker passed" },
    ]);

    assert.equal(result.status, 9);
    assert.equal(result.calls.length, 3);
    assert.match(result.stderr, /hook failed/);
});

test("coverage runner preserves checker rejection when report is missing", () => {
    const result = runWith([
        { status: 0, stdout: passingUnitOutput },
        { status: 0, stdout: "no report" },
        {
            status: 4,
            stderr: "raw coverage report was not produced",
        },
    ]);

    assert.equal(result.status, 4);
    assert.equal(result.calls.length, 3);
    assert.match(result.stderr, /raw coverage report was not produced/);
});

test("coverage runner fails closed when a child cannot start", () => {
    const result = runWith([
        {
            status: null,
            error: new Error("spawn unavailable"),
        },
    ]);

    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 1);
    assert.match(result.stderr, /spawn unavailable/);
});
