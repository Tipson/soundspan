import { defineConfig, devices } from "@playwright/test";

// Intentionally fixed: these tests must never use an operator's production URL.
export const CORE_ORIGIN = "http://127.0.0.1:3137";

export default defineConfig({
    testDir: "./tests/e2e/core",
    timeout: 60_000,
    expect: { timeout: 12_000 },
    workers: 1,
    retries: 0,
    forbidOnly: true,
    outputDir: "output/playwright/core/results",
    reporter: [
        ["list"],
        ["json", { outputFile: "output/playwright/core/report.json" }],
    ],
    use: {
        ...devices["Pixel 7"],
        browserName: "chromium",
        baseURL: CORE_ORIGIN,
        // HTTP guards must see every request; offline-file playback uses OPFS,
        // independently of the separate service-worker bootstrap acceptance.
        serviceWorkers: "block",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    webServer: {
        command: "node server.js",
        url: CORE_ORIGIN,
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
            NODE_ENV: "production",
            PORT: "3137",
            BACKEND_URL: "http://127.0.0.1:9",
            STREAMING_ENGINE_MODE: "native",
        },
    },
});
