import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendRoot = fileURLToPath(new URL("../", import.meta.url));
const checkerPath = fileURLToPath(
    new URL("./check-targeted-coverage.mjs", import.meta.url),
);
const maxBuffer = 64 * 1024 * 1024;

function childExitCode(result) {
    if (result.error) {
        return 1;
    }
    return typeof result.status === "number" ? result.status : 1;
}

function writeChildOutput(result, stdout, stderr) {
    if (result.stdout) stdout.write(result.stdout);
    if (result.stderr) stderr.write(result.stderr);
    if (result.error) stderr.write(`${result.error.message}\n`);
}

function summaryValue(output, label) {
    const matches = [
        ...output.matchAll(new RegExp(`(?:ℹ|#)\\s+${label}\\s+(\\d+)`, "gu")),
    ];
    return matches.length === 1 ? Number(matches[0][1]) : null;
}

function hasPassingUnitSummary(output) {
    const tests = summaryValue(output, "tests");
    const pass = summaryValue(output, "pass");
    const fail = summaryValue(output, "fail");
    return (
        tests !== null &&
        pass !== null &&
        fail === 0 &&
        tests > 0 &&
        pass > 0 &&
        pass <= tests
    );
}

/**
 * Runs the full unit suite before the strict native targeted-coverage phase.
 * Child-process injection keeps the fail-closed orchestration contract testable.
 */
export function runTargetedCoverage({
    cwd = frontendRoot,
    execPath = process.execPath,
    npmExecPath = process.env.npm_execpath,
    spawn = spawnSync,
    stdout = process.stdout,
    stderr = process.stderr,
} = {}) {
    if (!npmExecPath) {
        stderr.write(
            "targeted coverage runner failed: npm_execpath is unavailable; run through npm\n",
        );
        return 1;
    }

    const spawnOptions = {
        cwd,
        encoding: "utf8",
        maxBuffer,
        windowsHide: true,
    };
    const unitResult = spawn(
        execPath,
        [npmExecPath, "run", "test:unit"],
        spawnOptions,
    );
    writeChildOutput(unitResult, stdout, stderr);
    const unitExitCode = childExitCode(unitResult);
    if (unitExitCode !== 0) return unitExitCode;

    const unitOutput = `${unitResult.stdout ?? ""}\n${unitResult.stderr ?? ""}`;
    if (!hasPassingUnitSummary(unitOutput)) {
        stderr.write(
            "targeted coverage runner failed: full unit test summary was not passing\n",
        );
        return 1;
    }

    const coverageResult = spawn(
        execPath,
        [npmExecPath, "run", "test:coverage:raw"],
        spawnOptions,
    );
    writeChildOutput(coverageResult, stdout, stderr);
    const coverageOutput = `${coverageResult.stdout ?? ""}\n${coverageResult.stderr ?? ""}`;
    const checkerResult = spawn(execPath, [checkerPath], {
        ...spawnOptions,
        input: coverageOutput,
    });
    writeChildOutput(checkerResult, stdout, stderr);

    const coverageExitCode = childExitCode(coverageResult);
    if (coverageExitCode !== 0) {
        if (coverageResult.error) {
            stderr.write(`${coverageResult.error.message}\n`);
        }
        stderr.write(
            `targeted coverage runner failed: native coverage phase exited with ${coverageExitCode}\n`,
        );
        return coverageExitCode;
    }

    const checkerExitCode = childExitCode(checkerResult);
    if (checkerExitCode !== 0) return checkerExitCode;
    return 0;
}

const invokedPath = process.argv[1]
    ? pathToFileURL(resolve(process.argv[1])).href
    : null;
if (invokedPath === import.meta.url) {
    process.exitCode = runTargetedCoverage();
}
