import { z } from "zod";
import { musicSourceCandidateSchema } from "./audio/musicSourcePlayback";

export type PlayCreateSource = "youtube" | "vk" | "yandex";
export type PlayCreateBinding = Readonly<{
    ownerId: string;
    loginNonce: string;
    authGeneration: number;
    networkGeneration: number;
}>;
/** Persist the frozen wire string, never an audio Track or a mutable provider object. */
export type PlayCreatePayload = Readonly<{
    source: PlayCreateSource;
    wireJson: string;
}>;
export type PlayCreateKey = Readonly<{
    value: string;
    epoch: number;
    issuedAtMs: number;
    expiresAtMs: number;
}>;
/** Only a capability receipt from this module can be admitted; serialization revokes it. */
export type PlayCreateGrant = Readonly<{ binding: PlayCreateBinding }>;
export type PlayCreateAdmission = Readonly<{
    historyEpoch: number;
    serverNowMs: number;
}>;

const replayWindowMs = 86_400_000;
const futureSkewMs = 300_000;
const maxDateMs = 8_640_000_000_000_000;
const maxEpoch = 2_147_483_647;
const sourceSchema = z.enum(["youtube", "vk", "yandex"]);
const epochSchema = z.number().int().min(0).max(maxEpoch);
const bindingSchema = z
    .object({
        ownerId: z.string().min(1),
        loginNonce: z.string().min(1),
        authGeneration: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER),
        networkGeneration: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER),
    })
    .strict();
const payloadSchema = z
    .object({
        youtubeVideoId: z.string().trim().min(1).optional(),
        musicSourceRecording: musicSourceCandidateSchema.optional(),
        title: z.string().trim().min(1).optional(),
        artist: z.string().trim().min(1).optional(),
        album: z.string().trim().min(1).optional(),
        duration: z.number().int().nonnegative().optional(),
        thumbnailUrl: z.string().trim().min(1).optional(),
        playContext: z
            .enum([
                "wave",
                "home",
                "search",
                "playlist",
                "album",
                "artist",
                "library",
            ])
            .optional(),
        waveMode: z.enum(["for-you", "new", "familiar"]).optional(),
        recommendationGenerationId: z
            .string()
            .trim()
            .min(1)
            .max(128)
            .optional(),
        recommendationSessionId: z.string().trim().min(1).max(128).optional(),
    })
    .strict()
    .refine(
        (value) =>
            Number(value.youtubeVideoId !== undefined) +
                Number(value.musicSourceRecording !== undefined) ===
                1 &&
            (value.youtubeVideoId === undefined ||
                (value.title !== undefined &&
                    value.artist !== undefined &&
                    value.album !== undefined &&
                    value.duration !== undefined)),
    );
const recordingFields = new Set([
    "provider",
    "id",
    "title",
    "artists",
    "duration",
    "contentVersion",
    "preview",
    "isrc",
]);
const capabilitySchema = z
    .object({
        version: z.literal(1),
        newCreationsEnabled: z.boolean(),
        replaySupported: z.boolean(),
        createPath: z.literal("/api/plays/idempotent"),
        ownerHistoryEpoch: epochSchema,
        serverNowMs: z.number().int().nonnegative().max(maxDateMs),
        replayWindowSeconds: z.literal(86_400),
        futureSkewSeconds: z.literal(300),
        capabilityTtlSeconds: z.number().positive().max(300),
        allowedSources: z
            .array(sourceSchema)
            .max(3)
            .refine((sources) => new Set(sources).size === sources.length),
    })
    .strict();
type GrantData = {
    readonly policy: z.infer<typeof capabilitySchema>;
    readonly receivedMonotonicMs: number;
    lastObservedMonotonicMs: number;
};
const grants = new WeakMap<PlayCreateGrant, GrantData>();

/** Snapshot only own data fields; do not invoke getters while validating untrusted DTOs. */
function dataRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    try {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== null && prototype !== Object.prototype) return null;
        const result: Record<string, unknown> = Object.create(null);
        for (const key of Reflect.ownKeys(value)) {
            // Zod deliberately drops this key instead of reporting it as unknown.
            if (typeof key !== "string" || key === "__proto__") return null;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (
                !descriptor ||
                !("value" in descriptor) ||
                !descriptor.enumerable
            )
                return null;
            result[key] = descriptor.value;
        }
        return result;
    } catch {
        return null;
    }
}

/** Match accepted remote Play semantics while excluding URLs, credentials and identity claims. */
export function projectPlayCreatePayload(
    input: unknown,
): PlayCreatePayload | null {
    const row = dataRecord(input);
    if (!row) return null;
    try {
        if (row.musicSourceRecording !== undefined) {
            const recording = dataRecord(row.musicSourceRecording);
            if (
                !recording ||
                Object.keys(recording).some((key) => !recordingFields.has(key))
            )
                return null;
            row.musicSourceRecording = recording;
        }
        const parsed = payloadSchema.safeParse(row);
        if (!parsed.success) return null;
        const { thumbnailUrl: _thumbnailUrl, ...payload } = parsed.data;
        const wireJson = JSON.stringify(payload);
        if (new TextEncoder().encode(wireJson).byteLength > 65_536) return null;
        const source = payload.musicSourceRecording?.provider ?? "youtube";
        return Object.freeze({ source, wireJson });
    } catch {
        return null;
    }
}

/** Call only for a fresh no-store HTTP receipt; transport/cache provenance belongs to the caller. */
export function readPlayCreateGrant(
    raw: unknown,
    binding: PlayCreateBinding,
    receivedMonotonicMs: number,
): PlayCreateGrant | null {
    const row = dataRecord(raw),
        owner = dataRecord(binding);
    if (
        !row ||
        !owner ||
        !Number.isFinite(receivedMonotonicMs) ||
        receivedMonotonicMs < 0
    )
        return null;
    try {
        const parsed = capabilitySchema.safeParse(row),
            copiedBinding = bindingSchema.safeParse(owner);
        if (!parsed.success || !copiedBinding.success) return null;
        const grant = Object.freeze({
            binding: Object.freeze(copiedBinding.data),
        });
        grants.set(grant, {
            policy: parsed.data,
            receivedMonotonicMs,
            lastObservedMonotonicMs: receivedMonotonicMs,
        });
        return grant;
    } catch {
        return null;
    }
}

/** Admission is local permission for one operation, not a reusable network or IDB lease. */
export function admitPlayCreateGrant(
    grant: PlayCreateGrant,
    options: {
        binding: PlayCreateBinding;
        nowMonotonicMs: number;
        online: boolean;
        intent:
            | { kind: "new"; source: PlayCreateSource }
            | { kind: "replay"; key: string }
            /** Read current lease scope for recovery/known engagement; never authorize creation. */
            | { kind: "restore" };
    },
): PlayCreateAdmission | null {
    const data = grants.get(grant);
    if (!data) return null;
    if (
        options.online !== true ||
        !Number.isFinite(options.nowMonotonicMs) ||
        options.nowMonotonicMs < data.lastObservedMonotonicMs
    ) {
        grants.delete(grant);
        return null;
    }
    data.lastObservedMonotonicMs = options.nowMonotonicMs;
    const elapsed = options.nowMonotonicMs - data.receivedMonotonicMs;
    const { policy } = data;
    if (
        elapsed < 0 ||
        elapsed >= policy.capabilityTtlSeconds * 1000 ||
        (options.intent.kind !== "restore" && !policy.replaySupported)
    )
        return null;
    const expected = dataRecord(options.binding);
    if (
        !expected ||
        !Object.keys(grant.binding).every(
            (key) =>
                expected[key] === grant.binding[key as keyof PlayCreateBinding],
        )
    )
        return null;
    const serverNowMs = policy.serverNowMs + elapsed;
    if (!Number.isFinite(serverNowMs) || serverNowMs > maxDateMs) return null;
    if (options.intent.kind === "new") {
        if (
            !policy.newCreationsEnabled ||
            !policy.allowedSources.includes(options.intent.source)
        )
            return null;
    } else if (options.intent.kind === "replay") {
        const key = readPlayCreateKey(options.intent.key);
        // An existing receipt remains replayable during producer rollback (allowedSources=[]).
        if (
            !key ||
            key.epoch !== policy.ownerHistoryEpoch ||
            serverNowMs >= key.expiresAtMs ||
            key.issuedAtMs > serverNowMs + futureSkewMs
        )
            return null;
    } else if (options.intent.kind !== "restore") return null;
    return Object.freeze({
        historyEpoch: policy.ownerHistoryEpoch,
        serverNowMs,
    });
}

/** Keep the server's canonical p1 grammar and representable 24h date arithmetic unchanged. */
export function readPlayCreateKey(value: unknown): PlayCreateKey | null {
    if (typeof value !== "string" || value.length > 64) return null;
    const match =
        /^p1\.([0-9a-z]{1,6})\.([0-9a-z]{1,11})\.([A-Za-z0-9_-]{32})$/.exec(
            value,
        );
    if (!match || match[0] !== value) return null;
    const epoch = Number.parseInt(match[1], 36),
        issuedAtMs = Number.parseInt(match[2], 36);
    if (
        !Number.isSafeInteger(epoch) ||
        epoch < 0 ||
        epoch > maxEpoch ||
        epoch.toString(36) !== match[1] ||
        !Number.isSafeInteger(issuedAtMs) ||
        issuedAtMs < 0 ||
        issuedAtMs > maxDateMs - replayWindowMs ||
        issuedAtMs.toString(36) !== match[2]
    )
        return null;
    return Object.freeze({
        value,
        epoch,
        issuedAtMs,
        expiresAtMs: issuedAtMs + replayWindowMs,
    });
}

/** The caller supplies cryptographic nonce and admitted server time; this module owns no clock/RNG. */
export function makePlayCreateKey(
    epoch: number,
    issuedAtMs: number,
    nonce32: string,
): PlayCreateKey | null {
    if (
        !Number.isInteger(epoch) ||
        epoch < 0 ||
        epoch > maxEpoch ||
        !Number.isFinite(issuedAtMs) ||
        issuedAtMs < 0 ||
        typeof nonce32 !== "string" ||
        !/^[A-Za-z0-9_-]{32}$/.test(nonce32) ||
        nonce32.length !== 32
    )
        return null;
    return readPlayCreateKey(
        `p1.${epoch.toString(36)}.${Math.floor(issuedAtMs).toString(36)}.${nonce32}`,
    );
}
