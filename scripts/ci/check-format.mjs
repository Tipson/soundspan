import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Check every formatting surface and preserve all failures on Windows and Unix. */
export function runFormatChecks({
    npmCli = process.env.npm_execpath,
    run = spawnSync,
} = {}) {
    if (!npmCli)
        throw new Error("Run this check through npm run format:check.");
    const commands = [
        ...["packages/media-metadata-contract", "backend", "frontend"].map(
            (directory) => [
                npmCli,
                "--prefix",
                directory,
                "run",
                "format:check",
            ],
        ),
        [
            resolve(repoRoot, "backend/node_modules/prettier/bin/prettier.cjs"),
            "--check",
            "scripts",
            "healthcheck-prod.js",
            "docker-bake.json",
            "package.json",
            ".prettierrc.json",
        ],
    ];
    let failed = false;
    for (const args of commands) {
        const result = run(process.execPath, args, {
            cwd: repoRoot,
            stdio: "inherit",
            shell: false,
        });
        if (result.status !== 0 || result.error) failed = true;
    }
    return failed ? 1 : 0;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    process.exitCode = runFormatChecks();
}
