// Source-format-insensitive fallback: a vm-based behavioral rewrite perturbs Node
// coverage attribution of unrelated modules under --experimental-test-coverage
// (Node 26 artifact); revisit when the coverage gate moves off pinned line numbers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceWorkerSource = readFileSync(
    new URL("../../public/sw.js", import.meta.url),
    "utf8",
);

test("service worker bypasses Next.js route transition requests", () => {
    assert.match(serviceWorkerSource, /request\.mode\s*===\s*['"]navigate['"]/);
    assert.match(
        serviceWorkerSource,
        /request\.headers\.get\(\s*['"]RSC['"]\s*\)\s*===\s*['"]1['"]/,
    );
    assert.match(
        serviceWorkerSource,
        /request\.headers\.has\(\s*['"]Next-Router-State-Tree['"]\s*\)/,
    );
    assert.match(
        serviceWorkerSource,
        /url\.pathname\.startsWith\(\s*['"]\/_next\/['"]\s*\)/,
    );
});

test("service worker keeps conservative cover-art concurrency", () => {
    assert.match(
        serviceWorkerSource,
        /const\s+MAX_CONCURRENT_IMAGE_REQUESTS\s*=\s*4\s*;/,
    );
});

test("service worker activates waiting updates only after explicit client message", () => {
    assert.match(
        serviceWorkerSource,
        /event\.data\?\.type\s*===\s*['"]SKIP_WAITING['"]/,
    );
    assert.match(serviceWorkerSource, /self\.skipWaiting\(\s*\)\s*;/);
});
