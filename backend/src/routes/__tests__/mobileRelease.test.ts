import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import * as fs from "node:fs/promises";
import os from "node:os";
import pathModule from "node:path";
import { createHash } from "node:crypto";

jest.mock("../../utils/db", () => ({
    prisma: {
        user: { findUnique: jest.fn() },
        apiKey: { findUnique: jest.fn(), update: jest.fn() },
    },
}));
jest.mock("../../utils/logger", () => {
    const log = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    log.child.mockReturnValue(log);
    return { logger: log };
});
jest.mock("../../services/featureDetection", () => ({
    featureDetection: { getFeatures: jest.fn() },
}));
jest.mock("../../config", () => ({
    config: {
        mobileReleaseRoot: undefined,
        recommendations: {},
        playCreation: {},
    },
}));

import { prisma } from "../../utils/db";
import { config } from "../../config";

const secret = "dev31-local-behavior-secret-123456789";
const path = "/api/system/mobile-release/manifest";
const user = { id: "owner-a", username: "a", role: "user", tokenVersion: 3 };
let app: express.Express;
const bearer = (overrides: Record<string, unknown> = {}) =>
    jwt.sign({ userId: user.id, tokenVersion: 3, ...overrides }, secret, {
        expiresIn: "1h",
    });
const read = (query = "channel=stable") =>
    request(app)
        .get(`${path}?${query}`)
        .set("Authorization", `Bearer ${bearer()}`);
let root: string | undefined;
const sha = (value: Buffer | string) =>
    createHash("sha256").update(value).digest("hex");
const signer =
    "9692faedf466e915de5bc02e2f4cbabc2b835c2a3dfd78ba47069820e3430b8c";
async function release(channel = "stable") {
    root ??= await fs.mkdtemp(
        pathModule.join(os.tmpdir(), "dev31-mobile-release-"),
    );
    config.mobileReleaseRoot = root;
    // Signature verification belongs to the trusted operator receipt, not this synthetic byte fixture.
    const apk = Buffer.from(
        "synthetic APK bytes; not an Android install fixture",
    );
    const hash = sha(apk);
    const manifest = {
        schemaVersion: 1,
        channel,
        versionCode: 30,
        versionName: "0.1.27",
        applicationId: "ru.agentik007.soundspan",
        apkPath: `/mobile-releases/android/${channel}/30/${hash}.apk`,
        bytes: apk.length,
        sha256: hash,
        signerSha256: signer,
        minSdk: 24,
        abis: ["arm64-v8a"],
        requiredCapabilities: { importDrafts: 1 },
    };
    const marker = pathModule.join(root, "channels", `${channel}.json`);
    const asset = pathModule.join(
        root,
        "android",
        channel,
        "30",
        `${hash}.apk`,
    );
    const receipt = pathModule.join(
        root,
        "receipts",
        "android",
        channel,
        "30",
        `${hash}.json`,
    );
    for (const target of [marker, asset, receipt])
        await fs.mkdir(pathModule.dirname(target), { recursive: true });
    await fs.writeFile(asset, apk);
    async function write(
        value: object = manifest,
        receiptOverrides: object = {},
    ) {
        const bytes = JSON.stringify(value);
        await fs.writeFile(marker, bytes);
        await fs.writeFile(
            receipt,
            JSON.stringify({
                schemaVersion: 1,
                manifestSha256: sha(bytes),
                apkSha256: hash,
                apkBytes: apk.length,
                signerSha256: signer,
                apkSignatureVerified: true,
                ...receiptOverrides,
            }),
        );
    }
    await write();
    return { manifest, marker, asset, receipt, write };
}

beforeAll(() => {
    process.env.JWT_SECRET = secret;
    app = express();
    app.use("/api/system", require("../system").default);
});
beforeEach(() => {
    jest.clearAllMocks();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...user });
    config.mobileReleaseRoot = undefined;
});
afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
});

test("default configuration has no release and cannot be cached", async () => {
    const response = await read();
    expect(response.status).toBe(204);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.text).toBe("");
});
test("manifest requires existing real authentication even when disabled", async () => {
    const response = await request(app).get(`${path}?channel=stable`);
    expect(response.status).toBe(401);
    expect(response.headers["cache-control"]).toBe("private, no-store");
});
test.each([
    "",
    "channel=nightly",
    "channel=stable&channel=test",
    "channel[]=stable",
    "channel=../stable",
    "channel=stable&userId=owner-b",
])("rejects malformed/ambiguous query %s", async (query) => {
    const response = await read(query);
    expect(response.status).toBe(400);
    expect(response.headers["cache-control"]).toBe("private, no-store");
});
test("publishes exact12 metadata for both authenticated owners, not filesystem fields", async () => {
    const f = await release();
    const a = await read();
    expect(a.status).toBe(200);
    expect(a.body).toEqual(f.manifest);
    expect(Object.keys(a.body)).toHaveLength(12);
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        ...user,
        id: "owner-b",
    });
    const b = await request(app)
        .get(`${path}?channel=stable`)
        .set("Authorization", `Bearer ${bearer({ userId: "owner-b" })}`);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(b.headers["cache-control"]).toBe("private, no-store");
});
test("channel markers are fresh and revocation is visible without restart", async () => {
    const f = await release();
    expect((await read()).status).toBe(200);
    expect((await read("channel=test")).status).toBe(204);
    await fs.unlink(f.marker);
    expect((await read()).status).toBe(204);
    await f.write();
    expect((await read()).body).toEqual(f.manifest);
});
test("conditional requests still get fresh200 without an ETag", async () => {
    await release();
    const response = await read()
        .set("If-None-Match", "*")
        .set("If-Modified-Since", new Date().toUTCString());
    expect(response.status).toBe(200);
    expect(response.headers.etag).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("private, no-store");
});
test.each([
    ["schema", { schemaVersion: 2 }],
    ["extra", { signature: "not-supported" }],
    ["package", { applicationId: "other.app" }],
    ["signer", { signerSha256: "0".repeat(64) }],
    ["numeric-string", { versionCode: "30" }],
    ["channel", { channel: "test" }],
    ["URL", { apkPath: "https://elsewhere.example/a.apk" }],
    ["traversal", { apkPath: "/mobile-releases/../a.apk" }],
    ["size", { bytes: 268435457 }],
    ["ABI", { abis: ["arm64-v8a", "arm64-v8a"] }],
    ["caps", { requiredCapabilities: { future: 1 } }],
    ["version", { versionName: "bad\nname" }],
])("fails closed for malformed manifest %s", async (_name, override) => {
    const f = await release();
    await f.write({ ...f.manifest, ...override });
    const response = await read();
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
        error: "Mobile release unavailable",
        code: "MOBILE_RELEASE_UNAVAILABLE",
    });
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.text).not.toContain(root);
});
test.each(["missing", "hash", "signature", "oversize"])(
    "requires a bounded bound verification receipt: %s",
    async (kind) => {
        const f = await release();
        if (kind === "missing") await fs.unlink(f.receipt);
        if (kind === "hash")
            await f.write(f.manifest, { manifestSha256: "f".repeat(64) });
        if (kind === "signature")
            await f.write(f.manifest, { apkSignatureVerified: false });
        if (kind === "oversize")
            await fs.writeFile(f.receipt, " ".repeat(65537));
        expect((await read()).status).toBe(503);
    },
);
test.each(["malformed", "oversize"])(
    "rejects bounded marker input %s",
    async (kind) => {
        const f = await release();
        await fs.writeFile(
            f.marker,
            kind === "malformed" ? "{" : " ".repeat(65537),
        );
        expect((await read()).status).toBe(503);
    },
);
test.each(["missing", "size", "hardlink"])(
    "rejects unsafe asset %s",
    async (kind) => {
        const f = await release();
        if (kind === "missing") await fs.unlink(f.asset);
        if (kind === "size") await fs.appendFile(f.asset, "extra");
        if (kind === "hardlink")
            await fs.link(f.asset, pathModule.join(root!, "extra.apk"));
        expect((await read()).status).toBe(503);
    },
);
test("rejects a symlink/junction root without following it", async () => {
    await release();
    const link = `${root}-link`;
    await fs.symlink(
        root!,
        link,
        process.platform === "win32" ? "junction" : "dir",
    );
    config.mobileReleaseRoot = link;
    try {
        expect((await read()).status).toBe(503);
    } finally {
        await fs.unlink(link);
    }
});
test("rejects a linked asset ancestor", async () => {
    const f = await release();
    const folder = pathModule.dirname(f.asset),
        moved = `${folder}-real`;
    await fs.rename(folder, moved);
    await fs.symlink(
        moved,
        folder,
        process.platform === "win32" ? "junction" : "dir",
    );
    expect((await read()).status).toBe(503);
});
test.each(["expired", "refresh", "tokenVersion", "query"])(
    "existing real auth rejects %s before release IO",
    async (kind) => {
        config.mobileReleaseRoot = "not-absolute-and-does-not-exist";
        const token =
            kind === "expired"
                ? jwt.sign({ userId: user.id, tokenVersion: 3 }, secret, {
                      expiresIn: -1,
                  })
                : bearer(
                      kind === "refresh"
                          ? { type: "refresh" }
                          : { tokenVersion: 2 },
                  );
        const requestValue = request(app).get(
            `${path}?channel=stable${kind === "query" ? `&token=${token}` : ""}`,
        );
        if (kind !== "query")
            requestValue.set("Authorization", `Bearer ${token}`);
        expect((await requestValue).status).toBe(401);
    },
);
test("auth storage failure remains503 before release IO without leaking metadata", async () => {
    config.mobileReleaseRoot = "bad-root";
    (prisma.user.findUnique as jest.Mock).mockRejectedValueOnce(
        new Error("database unavailable"),
    );
    const response = await read();
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("AUTH_BACKEND_UNAVAILABLE");
    expect(response.headers["cache-control"]).toBe("private, no-store");
});
test("does not expose a public upload endpoint", async () => {
    expect(
        (await request(app).post(path).send({ release: "arbitrary" })).status,
    ).toBe(404);
});
