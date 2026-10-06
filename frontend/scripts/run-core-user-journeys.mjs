import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertCoreJourneyReport } from "./core-journey-report.mjs";

const require = createRequire(import.meta.url);
const frontendRoot = fileURLToPath(new URL("../", import.meta.url));
const reportFile = new URL(
    "../output/playwright/core/report.json",
    import.meta.url,
);
// Only this fixed report file is removed, so stale results cannot pass the gate.
rmSync(reportFile, { force: true });
const result = spawnSync(
    process.execPath,
    [
        require.resolve("@playwright/test/cli"),
        "test",
        "--config",
        "playwright.core.config.ts",
    ],
    { cwd: frontendRoot, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const count = assertCoreJourneyReport(
    JSON.parse(readFileSync(reportFile, "utf8")),
);
console.log(`Core journey gate: ${count} passed, zero skips or retries`);
