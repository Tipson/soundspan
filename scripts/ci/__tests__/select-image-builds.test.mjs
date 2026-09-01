import assert from "node:assert/strict";
import { test } from "node:test";

import { selectImageBuilds } from "../select-image-builds.mjs";

function ids(result) {
    return result.include.map((image) => image.id);
}

test("frontend-only changes build only the frontend image", () => {
    assert.deepEqual(
        ids(
            selectImageBuilds({
                changedPaths: ["frontend/app/page.tsx"],
            }),
        ),
        ["frontend"],
    );
});

test("backend changes build API and worker images", () => {
    assert.deepEqual(
        ids(
            selectImageBuilds({
                changedPaths: ["backend/src/index.ts"],
            }),
        ),
        ["backend", "backend-worker"],
    );
});

test("shared contract changes build all core images", () => {
    assert.deepEqual(
        ids(
            selectImageBuilds({
                changedPaths: ["packages/media-metadata-contract/src/index.ts"],
            }),
        ),
        ["backend", "backend-worker", "frontend"],
    );
});

test("shared Python runtime changes build all Python sidecars", () => {
    assert.deepEqual(
        ids(
            selectImageBuilds({
                changedPaths: ["services/common/sidecar_runtime_utils.py"],
            }),
        ),
        [
            "audio-analyzer",
            "vibe-provider-dclap",
            "tidal-streamer",
            "ytmusic-streamer",
        ],
    );
});

test("manual groups are deterministic and AIO is retired from CI", () => {
    assert.deepEqual(ids(selectImageBuilds({ scope: "analysis" })), [
        "audio-analyzer",
        "vibe-provider-dclap",
    ]);
    assert.equal(
        ids(selectImageBuilds({ scope: "all" })).includes("aio"),
        false,
    );
});

test("an empty changed-path set fails safe by building every split image", () => {
    assert.equal(selectImageBuilds({ changedPaths: [] }).include.length, 7);
});
