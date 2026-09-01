import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", {
    namedExports: { useRouter: () => ({ push: () => undefined }) },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            scanLibrary: async () => ({ jobId: "scan-1" }),
            getScanStatus: async () => ({ status: "running", progress: 0 }),
            post: async () => ({}),
        },
    },
});

test("sync starts in a named, accessible progress surface", async () => {
    const { default: SyncPage } = await import("../../app/sync/page");
    const html = renderToStaticMarkup(React.createElement(SyncPage));

    assert.match(html, /data-utility-page="sync"/);
    assert.doesNotMatch(html, /data-utility-page="sync"[^>]*\bpb-/);
    assert.match(html, /data-page-header="editorial"/);
    assert.match(html, /role="progressbar"/);
    assert.match(html, /aria-valuemin="0"/);
    assert.match(html, /aria-valuemax="100"/);
    assert.match(html, /aria-valuenow="0"/);
    assert.match(html, /min-h-11/);
    assert.match(html, /Синхронизация коллекции/);
});
