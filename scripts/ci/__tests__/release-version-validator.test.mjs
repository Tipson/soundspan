import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const validator = path.join(
    repoRoot,
    "scripts/release/validate-release-version.sh",
);
const acceptedVersions = [
    "0.0.0",
    "1.2.3",
    "1.2.3-rc.1",
    "10.20.30-alpha-beta.7",
];
const rejectedVersions = [
    "",
    "v1.2.3",
    "1.2",
    "1.2.3+build.1",
    "1.2.3-rc.1+build.1",
    " 1.2.3",
    "1.2.3 ",
    "1.2.3/release",
    "android-v0.1.27+30",
];

function runValidator(version) {
    if (process.platform !== "win32") {
        return spawnSync(validator, [version], { encoding: "utf8" });
    }
    return spawnSync("bash", ["-s", "--", version], {
        encoding: "utf8",
        input: readFileSync(validator, "utf8").replaceAll("\r\n", "\n"),
    });
}

test("accepts the image workflow release version forms", () => {
    assert.equal(acceptedVersions.length, 4);
    for (let index = 0; index < 4; index += 1) {
        const version = acceptedVersions[index];
        const result = runValidator(version);
        assert.equal(result.status, 0, `${version}: ${result.stderr}`);
    }
});

test("rejects versions the image release workflow rejects", () => {
    assert.equal(rejectedVersions.length, 9);
    for (let index = 0; index < 9; index += 1) {
        const version = rejectedVersions[index];
        const result = runValidator(version);
        assert.notEqual(result.status, 0, `${version} was accepted`);
    }
});

// These workflows use scalar job conditions and inline needs. Execute that
// subset without dependencies: the infrastructure gate runs before npm ci.
function readJob(workflowName, jobId) {
    const source = readFileSync(
        path.join(repoRoot, ".github/workflows", workflowName),
        "utf8",
    );
    const heading = new RegExp(`^( +)${jobId}:\\s*\\r?\\n`, "m").exec(source);
    assert.ok(heading, `${workflowName}: missing ${jobId}`);
    const remainder = source.slice(heading.index + heading[0].length);
    const end = remainder.search(
        new RegExp(`^ {0,${heading[1].length}}\\S`, "m"),
    );
    const body = end === -1 ? remainder : remainder.slice(0, end);
    const indent = /^ +/.exec(body)[0].length;
    const field = (name) =>
        new RegExp(`^ {${indent}}${name}: ([^\\r\\n]+)$`, "m").exec(body)?.[1];
    return {
        condition: field("if") ?? "true",
        needs: (field("needs") ?? "")
            .replace(/[\[\]]/g, "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
    };
}

function shouldRun(job, github, completed = {}) {
    const needs = Object.fromEntries(
        job.needs.map((id) => {
            assert.ok(completed[id], `missing prerequisite result: ${id}`);
            return [id, completed[id]];
        }),
    );
    const success = () =>
        Object.values(needs).every((job) => job.result === "success");
    // GitHub supplies success() unless a status check overrides it. startsWith
    // is case insensitive; the logical operators here otherwise match JS.
    if (
        !/\b(?:always|success|failure|cancelled)\(/.test(job.condition) &&
        !success()
    ) {
        return false;
    }
    const expression = job.condition
        .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        .replace(/\bneeds\.([\w-]+)/g, (_, id) => `needs['${id}']`);
    return Boolean(
        runInNewContext(
            expression,
            {
                github,
                needs,
                success,
                always: () => true,
                startsWith: (value, prefix) =>
                    String(value ?? "")
                        .toLowerCase()
                        .startsWith(String(prefix).toLowerCase()),
            },
            { timeout: 1000 },
        ),
    );
}

const releaseCases = [
    ["Android prerelease", "android-v0.1.27+30", true, false],
    ["Android stable release", "android-v0.1.28+31", false, false],
    ["case-insensitive Android namespace", "ANDROID-v0.1.27+30", true, false],
    ["server stable release", "1.2.3", false, true],
    ["server prerelease", "1.2.3-rc.1", true, true],
    ["malformed server tag reaches validation", "v1.2.3", false, true],
    ["missing server tag reaches validation", "", false, true],
    ["similar prefix reaches validation", "androidish-1.2.3", true, true],
];

for (const [workflowName, jobId] of [
    ["image-builds.yml", "validate-release-tag"],
    ["image-builds.yml", "plan-images"],
    ["helm-chart-release.yml", "publish-helm-chart"],
]) {
    test(`${workflowName}: ${jobId} skips only Android release events`, () => {
        const job = readJob(workflowName, jobId);
        for (const [name, tag_name, prerelease, expected] of releaseCases) {
            assert.equal(
                shouldRun(job, {
                    event_name: "release",
                    event: { release: { tag_name, prerelease } },
                }),
                expected,
                name,
            );
        }
        for (const event_name of ["push", "workflow_dispatch"]) {
            assert.equal(
                shouldRun(job, {
                    event_name,
                    event: {},
                    ref: "refs/heads/main",
                }),
                true,
                event_name,
            );
        }
    });
}

test("image builds require successful validation and a nonempty image plan", () => {
    const job = readJob("image-builds.yml", "build-images");
    const github = { event_name: "release", event: {} };
    for (const result of ["failure", "skipped", "cancelled"]) {
        for (const prerequisite of ["validate-release-tag", "plan-images"]) {
            assert.equal(
                shouldRun(job, github, {
                    "validate-release-tag": { result: "success", outputs: {} },
                    "plan-images": {
                        result: "success",
                        outputs: { count: "6" },
                    },
                    [prerequisite]: { result, outputs: {} },
                }),
                false,
                `${prerequisite}: ${result}`,
            );
        }
    }
    for (const [count, expected] of [
        ["0", false],
        ["6", true],
    ]) {
        assert.equal(
            shouldRun(job, github, {
                "validate-release-tag": { result: "success", outputs: {} },
                "plan-images": { result: "success", outputs: { count } },
            }),
            expected,
            `planned images: ${count}`,
        );
    }
});
