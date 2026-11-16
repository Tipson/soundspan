import assert from "node:assert/strict";
import test from "node:test";
import {
    projectPlayCreatePayload as project,
    readPlayCreateGrant as readGrant,
    admitPlayCreateGrant as admit,
    makePlayCreateKey as makeKey,
    readPlayCreateKey as readKey,
    type PlayCreateBinding,
    type PlayCreateGrant,
    type PlayCreateSource,
} from "../../lib/playCreateJournal";
const nonce = "Ab_9-012345678901234567890123456";
const now = 1_800_000_000_000,
    receipt = 1000.25;
const binding: PlayCreateBinding = {
    ownerId: "owner-a",
    loginNonce: "login-a",
    authGeneration: 2,
    networkGeneration: 3,
};
const yt = () => ({
    youtubeVideoId: "video-1",
    title: "Song",
    artist: "Artist",
    album: "Album",
    duration: 180,
});
const native = (provider: "vk" | "yandex" = "vk") => ({
    musicSourceRecording: {
        provider,
        id: provider === "vk" ? "-001_02" : "00123",
        title: " Song ",
        artists: [" First ", "Second"],
        duration: 180.25,
        contentVersion: "clean",
        preview: false,
        isrc: "usABC2400001",
    },
});
const cap = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    newCreationsEnabled: true,
    replaySupported: true,
    createPath: "/api/plays/idempotent",
    ownerHistoryEpoch: 4,
    serverNowMs: now,
    replayWindowSeconds: 86_400,
    futureSkewSeconds: 300,
    capabilityTtlSeconds: 300,
    allowedSources: ["youtube", "vk", "yandex"],
    ...overrides,
});
function grant(overrides: Record<string, unknown> = {}) {
    const value = readGrant(cap(overrides), binding, receipt);
    assert.ok(value);
    return value;
}
function newAdmission(
    value = grant(),
    options: Partial<{
        binding: PlayCreateBinding;
        nowMonotonicMs: number;
        online: boolean;
        intent: { kind: "new"; source: PlayCreateSource };
    }> = {},
) {
    return admit(value, {
        binding,
        nowMonotonicMs: receipt,
        online: true,
        intent: { kind: "new", source: "youtube" },
        ...options,
    });
}
function key(time = now, epoch = 4) {
    const result = makeKey(epoch, time, nonce);
    assert.ok(result);
    return result;
}
function replay(value: PlayCreateGrant, text: string, delta = 0) {
    return admit(value, {
        binding,
        nowMonotonicMs: receipt + delta,
        online: true,
        intent: { kind: "replay", key: text },
    });
}

test("own JSON prototype-name extras cannot pass DTO, policy or binding validation", () => {
    const extra = <T extends object>(value: T): T => {
        Object.defineProperty(value, "__proto__", {
            value: { ignored: true },
            enumerable: true,
        });
        return value;
    };
    assert.equal(project(extra(yt())), null);
    assert.equal(readGrant(extra(cap()), binding, receipt), null);
    assert.equal(readGrant(cap(), extra({ ...binding }), receipt), null);
});

test("YouTube projection trims accepted metadata, drops thumbnail and freezes the artifact", () => {
    const result = project({
        ...yt(),
        title: " Song ",
        youtubeVideoId: " video-1 ",
        thumbnailUrl: " https://private.invalid/?token=secret ",
        playContext: "wave",
        waveMode: "new",
        recommendationGenerationId: " gen ",
        recommendationSessionId: " session ",
    });
    assert.ok(result);
    assert.equal(result.source, "youtube");
    assert.deepEqual(JSON.parse(result.wireJson), {
        ...yt(),
        playContext: "wave",
        waveMode: "new",
        recommendationGenerationId: "gen",
        recommendationSessionId: "session",
    });
    assert.ok(Object.isFrozen(result));
    assert.equal(result.wireJson.includes("secret"), false);
});
for (const provider of ["vk", "yandex"] as const)
    test(`${provider} preserves public exact ID, all artists, version, ISRC and fractional duration`, () => {
        const input = native(provider),
            result = project(input);
        assert.ok(result);
        assert.equal(result.source, provider);
        assert.deepEqual(JSON.parse(result.wireJson), {
            musicSourceRecording: {
                ...input.musicSourceRecording,
                title: "Song",
                artists: ["First", "Second"],
            },
        });
        const frozen = result.wireJson;
        input.musicSourceRecording.title = "Changed";
        input.musicSourceRecording.artists.push("Changed");
        input.musicSourceRecording.id = "9_9";
        assert.equal(result.wireJson, frozen);
        assert.equal(result.wireJson.includes("canonical"), false);
    });
test("all accepted contexts, modes and recording versions remain supported", () => {
    for (const playContext of [
        "wave",
        "home",
        "search",
        "playlist",
        "album",
        "artist",
        "library",
    ])
        for (const waveMode of ["for-you", "new", "familiar"])
            assert.ok(project({ ...yt(), playContext, waveMode }));
    for (const contentVersion of ["explicit", "clean", "unknown"])
        assert.ok(
            project({
                musicSourceRecording: {
                    ...native().musicSourceRecording,
                    contentVersion,
                },
            }),
        );
});
const badPayloads: [string, unknown][] = [
    ["null", null],
    ["array", []],
    ["no identity", { title: "Song" }],
    ["local", { trackId: "local" }],
    ["tidal", { tidalTrackId: 1 }],
    ["mixed identity", { ...yt(), ...native() }],
    ["empty local marker", { ...yt(), trackId: "" }],
    ...Object.entries({
        youtubeVideoId: " ",
        title: " ",
        artist: null,
        album: undefined,
        duration: 1.5,
        playContext: "radio",
        waveMode: "daily",
        recommendationGenerationId: "x".repeat(129),
        recommendationSessionId: " ",
        thumbnailUrl: " ",
        token: "secret",
        mediaUrl: "https://secret.invalid",
        verifiedCanonicalKey: "asserted",
    }).map(([name, value]): [string, unknown] => [
        name,
        { ...yt(), [name]: value },
    ]),
    ...Object.entries({
        provider: "tidal",
        id: "vk:1_2",
        title: "x".repeat(201),
        artists: [],
        duration: 0,
        preview: true,
        contentVersion: "live",
        isrc: "invalid",
        streamUrl: "https://secret.invalid",
    }).map(([name, value]): [string, unknown] => [
        "native " + name,
        {
            musicSourceRecording: {
                ...native().musicSourceRecording,
                [name]: value,
            },
        },
    ]),
    [
        "yandex invalid ID",
        {
            musicSourceRecording: {
                ...native("yandex").musicSourceRecording,
                id: "-1",
            },
        },
    ],
    [
        "eleven artists",
        {
            musicSourceRecording: {
                ...native().musicSourceRecording,
                artists: Array(11).fill("A"),
            },
        },
    ],
    [
        "long artist",
        {
            musicSourceRecording: {
                ...native().musicSourceRecording,
                artists: ["x".repeat(101)],
            },
        },
    ],
    [
        "long native duration",
        {
            musicSourceRecording: {
                ...native().musicSourceRecording,
                duration: 3601,
            },
        },
    ],
];
for (const [name, input] of badPayloads)
    test(`projection rejects ${name} before POST`, () =>
        assert.equal(project(input), null));
test("remote duration is a finite nonnegative integer, native duration retains its own range", () => {
    for (const duration of [-1, Infinity, NaN])
        assert.equal(project({ ...yt(), duration }), null);
    assert.ok(project({ ...yt(), duration: 0 }));
    assert.ok(
        project({
            musicSourceRecording: {
                ...native().musicSourceRecording,
                duration: 3600,
            },
        }),
    );
});
test("64 KiB limit counts UTF-8 wire bytes, accepts exact boundary and never truncates", () => {
    const available =
        65_536 -
        Buffer.byteLength(JSON.stringify({ ...yt(), title: "" }), "utf8");
    const title =
        "界".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
    assert.ok(title.length < 65_536);
    const result = project({ ...yt(), title });
    assert.ok(result);
    assert.equal(Buffer.byteLength(result.wireJson, "utf8"), 65_536);
    assert.equal(JSON.parse(result.wireJson).title, title);
    assert.equal(project({ ...yt(), title: title + "x" }), null);
    assert.equal(project({ ...yt(), title: "界".repeat(22_000) }), null);
});
test("undefined optional fields disappear; accessors are rejected without being invoked", () => {
    const input = { ...yt(), playContext: undefined };
    assert.deepEqual(JSON.parse(project(input)!.wireJson), yt());
    let reads = 0;
    Object.defineProperty(input, "title", {
        get() {
            reads++;
            throw new Error("unexpected getter");
        },
        enumerable: true,
    });
    assert.equal(project(input), null);
    assert.equal(reads, 0);
});
test("grant copies binding and source list, freezes state and advances only from receipt monotonic time", () => {
    const mutable = { ...binding },
        raw = cap(),
        value = readGrant(raw, mutable, receipt);
    assert.ok(value);
    mutable.ownerId = "other";
    raw.allowedSources.length = 0;
    assert.ok(Object.isFrozen(value));
    assert.ok(Object.isFrozen(value.binding));
    const admission = newAdmission(value, {
        nowMonotonicMs: receipt + 123.75,
    });
    assert.deepEqual(admission, {
        historyEpoch: 4,
        serverNowMs: now + 123.75,
    });
    assert.ok(Object.isFrozen(admission));
});
const badCapabilities: [string, unknown][] = [
    ["null", null],
    ["array", []],
    ...Object.entries({
        version: 2,
        newCreationsEnabled: "true",
        replaySupported: undefined,
        createPath: "/plays/idempotent",
        ownerHistoryEpoch: -1,
        serverNowMs: NaN,
        replayWindowSeconds: 3600,
        futureSkewSeconds: 301,
        capabilityTtlSeconds: 0,
        allowedSources: ["local"],
        futurePolicy: true,
    }).map(([name, value]): [string, unknown] => [
        name,
        cap({ [name]: value }),
    ]),
    ...["https://host/api/plays/idempotent", "/api/plays/idempotent/"].map(
        (createPath): [string, unknown] => [createPath, cap({ createPath })],
    ),
    ...[1.5, 2_147_483_648].map((ownerHistoryEpoch): [string, unknown] => [
        "epoch " + ownerHistoryEpoch,
        cap({ ownerHistoryEpoch }),
    ]),
    ...[Infinity, -1, now + 0.5, 8_640_000_000_000_001].map(
        (serverNowMs): [string, unknown] => [
            "server time " + serverNowMs,
            cap({ serverNowMs }),
        ],
    ),
    ...[301, Infinity].map((capabilityTtlSeconds): [string, unknown] => [
        "TTL " + capabilityTtlSeconds,
        cap({ capabilityTtlSeconds }),
    ]),
    ["duplicate sources", cap({ allowedSources: ["vk", "vk"] })],
    ["string sources", cap({ allowedSources: "youtube" })],
];
for (const [name, input] of badCapabilities)
    test(`grant rejects ${name}`, () =>
        assert.equal(readGrant(input, binding, receipt), null));
test("receipt, epoch and binding bounds are enforced without coercion", () => {
    for (const time of [NaN, Infinity, -1])
        assert.equal(readGrant(cap(), binding, time), null);
    for (const patch of [
        { ownerId: "" },
        { loginNonce: "" },
        { authGeneration: -1 },
        { authGeneration: 1.5 },
        { networkGeneration: NaN },
        { networkGeneration: Number.MAX_SAFE_INTEGER + 1 },
    ])
        assert.equal(readGrant(cap(), { ...binding, ...patch }, receipt), null);
    assert.ok(readGrant(cap({ ownerHistoryEpoch: 0 }), binding, 0));
    assert.ok(
        readGrant(cap({ ownerHistoryEpoch: 2_147_483_647 }), binding, receipt),
    );
});
test("TTL exact boundary, monotonic rollback and offline state fail closed", () => {
    const value = grant();
    assert.ok(newAdmission(value, { nowMonotonicMs: receipt + 299_999.5 }));
    for (const nowMonotonicMs of [
        receipt + 300_000,
        receipt + 300_001,
        receipt - 0.01,
        NaN,
        Infinity,
    ])
        assert.equal(newAdmission(value, { nowMonotonicMs }), null);
    assert.ok(
        newAdmission(grant({ capabilityTtlSeconds: 1 }), {
            nowMonotonicMs: receipt + 999,
        }),
    );
    assert.equal(
        newAdmission(grant({ capabilityTtlSeconds: 1 }), {
            nowMonotonicMs: receipt + 1000,
        }),
        null,
    );
    assert.equal(newAdmission(value, { online: false }), null);
    assert.equal(
        newAdmission(value, { online: 1 as unknown as boolean }),
        null,
    );
});
test("serialized/cache-shaped grants and every mismatched owner/login/auth/network binding are rejected", () => {
    const value = grant();
    assert.equal(
        newAdmission(JSON.parse(JSON.stringify(value)) as PlayCreateGrant),
        null,
    );
    assert.equal(newAdmission({ ...value }), null);
    for (const patch of [
        { ownerId: "other" },
        { loginNonce: "other" },
        { authGeneration: 3 },
        { networkGeneration: 4 },
    ])
        assert.equal(
            newAdmission(value, { binding: { ...binding, ...patch } }),
            null,
        );
    assert.ok(newAdmission(value, { binding: { ...binding } }));
});
test("new creation needs both flags and exact source membership", () => {
    for (const policy of [
        { newCreationsEnabled: false },
        { replaySupported: false },
        { allowedSources: [] },
        { allowedSources: ["vk"] },
    ])
        assert.equal(newAdmission(grant(policy)), null);
    for (const source of ["youtube", "vk", "yandex"] as const)
        assert.ok(
            newAdmission(grant({ allowedSources: [source] }), {
                intent: { kind: "new", source },
            }),
        );
    assert.equal(
        newAdmission(grant(), {
            intent: { kind: "new", source: "tidal" as PlayCreateSource },
        }),
        null,
    );
});
test("producer rollback permits same-key replay with new disabled and empty allowedSources", () => {
    const value = grant({ newCreationsEnabled: false, allowedSources: [] }),
        text = key().value;
    assert.deepEqual(replay(value, text), {
        historyEpoch: 4,
        serverNowMs: now,
    });
    assert.equal(newAdmission(value), null);
    assert.equal(replay(grant({ replaySupported: false }), text), null);
});
test("replay enforces epoch, 24h expiry and inclusive 300s future skew with projected time", () => {
    for (const text of [
        key(now, 3).value,
        key(now - 86_400_000).value,
        key(now + 300_001).value,
        "malformed",
    ])
        assert.equal(replay(grant(), text), null);
    for (const text of [
        key(now - 86_400_000 + 1).value,
        key(now + 300_000).value,
    ])
        assert.ok(replay(grant(), text));
    assert.equal(replay(grant(), key(now - 86_400_000 + 1).value, 1), null);
});
test("key creation floors projected server time, round-trips canonical base36 and freezes output", () => {
    assert.equal(nonce.length, 32);
    const admission = newAdmission(grant(), {
        nowMonotonicMs: receipt + 125.75,
    });
    assert.ok(admission);
    const result = key(admission.serverNowMs);
    assert.equal(result.value, `p1.4.${(now + 125).toString(36)}.${nonce}`);
    assert.deepEqual(readKey(result.value), result);
    assert.equal(result.issuedAtMs, now + 125);
    assert.equal(result.expiresAtMs, now + 125 + 86_400_000);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(readKey(result.value)));
});
test("key parser matches backend epoch/date extrema and 64-character bound", () => {
    for (const epoch of [0, 2_147_483_647])
        for (const time of [0, 8_640_000_000_000_000 - 86_400_000]) {
            const result = key(time, epoch);
            assert.ok(result.value.length <= 64);
            assert.equal(readKey(result.value)?.epoch, epoch);
            assert.equal(readKey(result.value)?.issuedAtMs, time);
        }
});
test("key creation rejects invalid nonce, epoch and time without inventing randomness or wall-clock authority", () => {
    for (const text of [
        "",
        nonce.slice(1),
        nonce + "x",
        "!".repeat(32),
        "界".repeat(32),
        " ".repeat(32),
    ])
        assert.equal(makeKey(4, now, text), null);
    for (const epoch of [-1, 1.5, NaN, Infinity, 2_147_483_648])
        assert.equal(makeKey(epoch, now, nonce), null);
    for (const time of [
        -0.1,
        NaN,
        Infinity,
        8_640_000_000_000_000 - 86_400_000 + 1,
    ])
        assert.equal(makeKey(4, time, nonce), null);
});
test("key parser rejects noncanonical ASCII segments, coercions and alternate protocol", () => {
    const time = now.toString(36);
    for (const text of [
        undefined,
        null,
        {},
        123,
        `p2.4.${time}.${nonce}`,
        `p1.04.${time}.${nonce}`,
        `p1.4.0${time}.${nonce}`,
        `p1.4.${time.toUpperCase()}.${nonce}`,
        `p1.-1.${time}.${nonce}`,
        `p1.${(2_147_483_648).toString(36)}.${time}.${nonce}`,
        `p1.4.${(8_640_000_000_000_000 - 86_400_000 + 1).toString(36)}.${nonce}`,
        `p1.4.${time}.${nonce}\n`,
        `p1.4.${time}.${nonce}.x`,
        "x".repeat(65),
    ])
        assert.equal(readKey(text), null);
});

test("a monotonic rollback above the receipt permanently revokes that in-memory grant", () => {
    const value = grant();
    assert.ok(newAdmission(value, { nowMonotonicMs: receipt + 1000 }));
    assert.equal(newAdmission(value, { nowMonotonicMs: receipt + 500 }), null);
    assert.equal(newAdmission(value, { nowMonotonicMs: receipt + 1001 }), null);
    assert.ok(newAdmission(grant(), { nowMonotonicMs: receipt + 1001 }));
});
test("projected time cannot overflow the server date range", () => {
    const value = grant({ serverNowMs: 8_640_000_000_000_000 });
    assert.equal(newAdmission(value, { nowMonotonicMs: receipt + 1 }), null);
});
test("observed offline state revokes the grant rather than reviving it on a later online call", () => {
    const value = grant();
    assert.equal(newAdmission(value, { online: false }), null);
    assert.equal(newAdmission(value), null);
    assert.ok(newAdmission(grant()));
});
