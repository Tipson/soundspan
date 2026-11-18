import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isPlainObject } from "../utils/plainObject";

const applicationId = "ru.agentik007.soundspan";
const signerSha256 =
    "9692faedf466e915de5bc02e2f4cbabc2b835c2a3dfd78ba47069820e3430b8c";
const maxMetadataBytes = 64 * 1024;
const maxApkBytes = 256 * 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;
const manifestKeys = [
    "schemaVersion",
    "channel",
    "versionCode",
    "versionName",
    "applicationId",
    "apkPath",
    "bytes",
    "sha256",
    "signerSha256",
    "minSdk",
    "abis",
    "requiredCapabilities",
];
const receiptKeys = [
    "schemaVersion",
    "manifestSha256",
    "apkSha256",
    "apkBytes",
    "signerSha256",
    "apkSignatureVerified",
];

/** The fixed v1 payload accepted by the native updater; it contains no signature envelope. */
export interface MobileReleaseManifest {
    schemaVersion: 1;
    channel: "stable" | "test";
    versionCode: number;
    versionName: string;
    applicationId: typeof applicationId;
    apkPath: string;
    bytes: number;
    sha256: string;
    signerSha256: typeof signerSha256;
    minSdk: number;
    abis: string[];
    requiredCapabilities: Partial<Record<"importDrafts" | "orderedWave", 1>>;
}

function unavailable(): never {
    throw new Error("Mobile release unavailable");
}
function exactKeys(
    value: unknown,
    keys: string[],
): value is Record<string, unknown> {
    return (
        isPlainObject(value) &&
        Object.keys(value).length === keys.length &&
        keys.every((key) => Object.hasOwn(value, key))
    );
}
function integer(value: unknown, min: number, max: number): value is number {
    return (
        Number.isSafeInteger(value) &&
        (value as number) >= min &&
        (value as number) <= max
    );
}
function manifestFrom(
    value: unknown,
    channel: "stable" | "test",
): MobileReleaseManifest {
    if (
        !exactKeys(value, manifestKeys) ||
        value.schemaVersion !== 1 ||
        value.channel !== channel ||
        value.applicationId !== applicationId ||
        value.signerSha256 !== signerSha256 ||
        !integer(value.versionCode, 1, 2100000000) ||
        typeof value.versionName !== "string" ||
        value.versionName.length < 1 ||
        value.versionName.length > 64 ||
        /[\x00-\x1f\x7f]/.test(value.versionName) ||
        !integer(value.bytes, 1, maxApkBytes) ||
        typeof value.sha256 !== "string" ||
        !hashPattern.test(value.sha256) ||
        !integer(value.minSdk, 24, 10000) ||
        !Array.isArray(value.abis) ||
        value.abis.length < 1 ||
        value.abis.length > 3 ||
        new Set(value.abis).size !== value.abis.length ||
        value.abis.some(
            (abi) => !["armeabi-v7a", "arm64-v8a", "x86_64"].includes(abi),
        ) ||
        !isPlainObject(value.requiredCapabilities) ||
        Object.keys(value.requiredCapabilities).length > 2 ||
        Object.entries(value.requiredCapabilities).some(
            ([key, version]) =>
                !["importDrafts", "orderedWave"].includes(key) || version !== 1,
        ) ||
        value.apkPath !==
            `/mobile-releases/android/${channel}/${value.versionCode}/${value.sha256}.apk`
    )
        unavailable();
    return value as unknown as MobileReleaseManifest;
}

function samePath(a: string, b: string): boolean {
    return process.platform === "win32"
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
}
async function directory(root: string, segments: string[]): Promise<string> {
    let current = root;
    for (const segment of ["", ...segments]) {
        current = path.join(current, segment);
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable();
    }
    if (!samePath(await realpath(current), current)) unavailable();
    return current;
}
function sameFile(a: Stats, b: Stats): boolean {
    return (
        a.isFile() &&
        b.isFile() &&
        !a.isSymbolicLink() &&
        !b.isSymbolicLink() &&
        a.nlink === 1 &&
        b.nlink === 1 &&
        a.dev === b.dev &&
        a.ino === b.ino &&
        a.size === b.size &&
        a.mtimeMs === b.mtimeMs &&
        a.ctimeMs === b.ctimeMs
    );
}
async function checkedFile(root: string, segments: string[]) {
    const parents = segments.slice(0, -1);
    const parent = await directory(root, parents);
    const target = path.join(parent, segments[segments.length - 1]);
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
        unavailable();
    const file = await open(
        target,
        constants.O_RDONLY |
            (constants.O_NOFOLLOW ?? 0) |
            (constants.O_NONBLOCK ?? 0),
    );
    try {
        if (!sameFile(before, await file.stat())) unavailable();
        await directory(root, parents);
        return { file, target, before };
    } catch (error) {
        await file.close();
        throw error;
    }
}
async function readBounded(root: string, segments: string[]): Promise<Buffer> {
    const { file, target, before } = await checkedFile(root, segments);
    try {
        if (before.size < 1 || before.size > maxMetadataBytes) unavailable();
        const bytes = Buffer.alloc(maxMetadataBytes + 1);
        let offset = 0;
        while (offset < bytes.length) {
            const result = await file.read(
                bytes,
                offset,
                bytes.length - offset,
                offset,
            );
            if (result.bytesRead === 0) break;
            offset += result.bytesRead;
        }
        if (
            offset !== before.size ||
            offset > maxMetadataBytes ||
            !sameFile(before, await file.stat()) ||
            !sameFile(before, await lstat(target))
        )
            unavailable();
        return bytes.subarray(0, offset);
    } finally {
        await file.close();
    }
}

/**
 * Read the current operator-owned channel marker and its bound verification receipt.
 * The root is mounted read-only; only the trusted publisher can create artifacts.
 * APK signature/hash verification is performed by that publisher and by Android,
 * not repeated over a large APK in each request. No request can select a path.
 */
export async function readMobileRelease(
    root: string | undefined,
    channel: "stable" | "test",
): Promise<MobileReleaseManifest | null> {
    if (!root) return null;
    if (!path.isAbsolute(root) || !samePath(path.resolve(root), root))
        unavailable();
    await directory(root, []);
    const marker = ["channels", `${channel}.json`];
    let bytes: Buffer;
    try {
        bytes = await readBounded(root, marker);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    const manifest = manifestFrom(JSON.parse(bytes.toString("utf8")), channel);
    const artifact = [
        "android",
        channel,
        String(manifest.versionCode),
        manifest.sha256,
    ];
    const receipt = JSON.parse(
        (
            await readBounded(root, [
                "receipts",
                ...artifact.slice(0, -1),
                `${manifest.sha256}.json`,
            ])
        ).toString("utf8"),
    );
    if (
        !exactKeys(receipt, receiptKeys) ||
        receipt.schemaVersion !== 1 ||
        receipt.manifestSha256 !==
            createHash("sha256").update(bytes).digest("hex") ||
        receipt.apkSha256 !== manifest.sha256 ||
        receipt.apkBytes !== manifest.bytes ||
        receipt.signerSha256 !== signerSha256 ||
        receipt.apkSignatureVerified !== true
    )
        unavailable();
    const { file, target, before } = await checkedFile(root, [
        ...artifact.slice(0, -1),
        `${manifest.sha256}.apk`,
    ]);
    try {
        if (
            before.size !== manifest.bytes ||
            !sameFile(before, await file.stat()) ||
            !sameFile(before, await lstat(target))
        )
            unavailable();
    } finally {
        await file.close();
    }
    // Do not publish an earlier snapshot if the operator withdrew or replaced it during verification.
    let current: Buffer;
    try {
        current = await readBounded(root, marker);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    if (!bytes.equals(current)) unavailable();
    return manifest;
}
