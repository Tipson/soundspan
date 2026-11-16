import assert from "node:assert/strict";
import test from "node:test";
import {
    readPlayCreateAck,
    readPlayEngagementAck,
    readPlayRetryAfterMs,
} from "../../lib/playCreateWire";

const key = `p1.4.mwj7og00.${"A".repeat(32)}`;
const expiry = "2026-11-17T12:00:00.000Z";
const serverDate = "Mon, 16 Nov 2026 12:00:00 GMT";
const ack = () => ({
    id: "play-a",
    playCreation: {
        version: 1,
        clientPlaybackId: key,
        disposition: "created",
        replayExpiresAt: expiry,
    },
});

test("all ACK objects reject JSON-shaped own prototype-name extras before strict schema normalization", () => {
    for (const name of [
        "__proto__",
        "constructor",
        "prototype",
        "toString",
        "hasOwnProperty",
    ]) {
        for (const target of ["root", "nested"]) {
            const raw = ack();
            Object.defineProperty(
                target === "root" ? raw : raw.playCreation,
                name,
                { value: { ignored: true }, enumerable: true },
            );
            assert.equal(
                readPlayCreateAck(raw, key),
                null,
                `${target}:${name}`,
            );
        }
        const raw = { success: true };
        Object.defineProperty(raw, name, {
            value: { ignored: true },
            enumerable: true,
        });
        assert.equal(readPlayEngagementAck(raw), null, `engagement:${name}`);
    }
});

test("obsolete Retry-After uses the server century window across the next century", () => {
    for (const year of [1999, 2099]) {
        const start = new Date(0);
        start.setUTCFullYear(year, 11, 31);
        start.setUTCHours(23, 59, 59, 0);
        const next = new Date(start.getTime() + 1000);
        const weekdays = [
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
        ];
        const obsolete = `${weekdays[next.getUTCDay()]}, 01-Jan-00 00:00:00 GMT`;
        assert.equal(readPlayRetryAfterMs(obsolete, start.toUTCString()), 1000);
    }
});

test("create ACK snapshots created and replayed receipts as frozen exact values", () => {
    for (const disposition of ["created", "replayed"]) {
        const raw = ack();
        raw.playCreation.disposition = disposition;
        const result = readPlayCreateAck(raw, key);
        assert.deepEqual(result, raw);
        assert.ok(Object.isFrozen(result));
        assert.ok(Object.isFrozen(result?.playCreation));
        raw.id = "mutated";
        raw.playCreation.disposition = "mutated";
        assert.equal(result?.id, "play-a");
        assert.equal(result?.playCreation.disposition, disposition);
    }
});

test("create ACK rejects foreign keys, invalid expected keys and unknown protocol fields", () => {
    for (const expected of [
        "",
        `${key}\n`,
        key.replace("p1.4.", "p1.04."),
        key.replace("p1.4.", "p1.5."),
    ])
        assert.equal(readPlayCreateAck(ack(), expected), null);
    for (const patch of [
        { version: 2 },
        { version: "1" },
        { clientPlaybackId: `${key}x` },
        { disposition: "unknown" },
        { disposition: true },
        { extra: true },
    ])
        assert.equal(
            readPlayCreateAck(
                { ...ack(), playCreation: { ...ack().playCreation, ...patch } },
                key,
            ),
            null,
        );
});

test("create ACK expiry must equal the key's canonical ISO expiry exactly", () => {
    for (const replayExpiresAt of [
        "2026-11-17T12:00:00Z",
        "2026-11-17T15:00:00.000+03:00",
        "2026-11-17T12:00:00.001Z",
        "2026-11-18T12:00:00.000Z",
        null,
        1794916800000,
    ])
        assert.equal(
            readPlayCreateAck(
                {
                    ...ack(),
                    playCreation: { ...ack().playCreation, replayExpiresAt },
                },
                key,
            ),
            null,
        );
});

test("create ACK supports the representable key expiry boundaries without local time", () => {
    for (const [expectedKey, replayExpiresAt] of [
        [`p1.0.0.${"A".repeat(32)}`, "1970-01-02T00:00:00.000Z"],
        [`p1.0.2d2mh5ydc00.${"A".repeat(32)}`, "+275760-09-13T00:00:00.000Z"],
    ])
        assert.equal(
            readPlayCreateAck(
                {
                    id: "p",
                    playCreation: {
                        version: 1,
                        clientPlaybackId: expectedKey,
                        disposition: "replayed",
                        replayExpiresAt,
                    },
                },
                expectedKey,
            )?.playCreation.replayExpiresAt,
            replayExpiresAt,
        );
});

test("create ACK bounds the own trimmed play ID without coercing it", () => {
    for (const id of ["p", "p".repeat(128)])
        assert.equal(readPlayCreateAck({ ...ack(), id }, key)?.id, id);
    for (const id of [
        "",
        " ",
        " p",
        "p\n",
        "p".repeat(129),
        1,
        null,
        undefined,
        {
            toString() {
                throw new Error("coercion");
            },
        },
    ])
        assert.equal(readPlayCreateAck({ ...ack(), id }, key), null);
});

test("create ACK rejects arrays, missing fields, inherited data and all extra own fields", () => {
    for (const raw of [
        null,
        [],
        [ack()],
        {},
        { id: "p" },
        { ...ack(), extra: true },
        { ...ack(), playCreation: [] },
        Object.create(ack()),
    ])
        assert.equal(readPlayCreateAck(raw, key), null);
    for (const target of ["root", "nested"]) {
        for (const extra of ["hidden", Symbol("extra")]) {
            const raw = ack();
            Object.defineProperty(
                target === "root" ? raw : raw.playCreation,
                extra,
                { value: true },
            );
            assert.equal(readPlayCreateAck(raw, key), null);
        }
    }
    const raw = ack();
    assert.ok(readPlayCreateAck(Object.assign(Object.create(null), raw), key));
});

test("create ACK never invokes own or nested getters while rejecting them", () => {
    let reads = 0;
    for (const [target, name] of [
        ["root", "id"],
        ["root", "playCreation"],
        ["nested", "version"],
        ["nested", "replayExpiresAt"],
        ["nested", "extra"],
    ]) {
        const raw = ack();
        Object.defineProperty(
            target === "root" ? raw : raw.playCreation,
            name,
            {
                enumerable: true,
                get() {
                    reads++;
                    throw new Error("getter");
                },
            },
        );
        assert.equal(readPlayCreateAck(raw, key), null);
    }
    assert.equal(reads, 0);
});

test("engagement ACK preserves absence and both boolean stale values in a frozen copy", () => {
    for (const raw of [
        { success: true },
        { success: true, stale: true },
        { success: true, stale: false },
    ]) {
        const result = readPlayEngagementAck(raw);
        assert.deepEqual(result, raw);
        assert.ok(Object.isFrozen(result));
        assert.notEqual(result, raw);
    }
});

test("engagement ACK rejects malformed, diagnostic and non-wire bodies exactly", () => {
    for (const raw of [
        null,
        [],
        true,
        {},
        { success: false },
        { success: 1 },
        { success: "true" },
        { success: true, stale: undefined },
        { success: true, stale: 0 },
        { success: true, diagnostic: true },
        Object.create({ success: true }),
    ])
        assert.equal(readPlayEngagementAck(raw), null);
    const raw = { success: true };
    Object.defineProperty(raw, Symbol("extra"), { value: 1 });
    assert.equal(readPlayEngagementAck(raw), null);
});

test("engagement ACK rejects getters without invoking them", () => {
    let reads = 0;
    for (const field of ["success", "stale", "extra"]) {
        const raw = { success: true };
        Object.defineProperty(raw, field, {
            enumerable: true,
            get() {
                reads++;
                throw new Error("getter");
            },
        });
        assert.equal(readPlayEngagementAck(raw), null);
    }
    assert.equal(reads, 0);
});

test("Retry-After delta seconds accepts zero and OWS, clamping valid long delays", () => {
    for (const [raw, expected] of [
        ["0", 0],
        ["000", 0],
        ["\t 00120 \t", 120000],
        ["86400", 86400000],
        ["86401", 86400000],
        ["9999999999999999", 86400000],
    ] as const)
        assert.equal(readPlayRetryAfterMs(raw, null), expected);
});

test("Retry-After rejects malformed, oversized and coercible input", () => {
    for (const raw of [
        undefined,
        null,
        1,
        0,
        NaN,
        true,
        ["1"],
        {
            toString() {
                throw new Error("coercion");
            },
        },
        "",
        " ",
        "-1",
        "+1",
        "1.0",
        "1e3",
        "0x10",
        "Infinity",
        "1, 2",
        "1\n",
        "１",
        "9".repeat(129),
    ])
        assert.equal(readPlayRetryAfterMs(raw, serverDate), null);
});

test("Retry-After accepts all three HTTP-date forms against the server Date", () => {
    for (const retry of [
        "Mon, 16 Nov 2026 12:02:00 GMT",
        "Monday, 16-Nov-26 12:02:00 GMT",
        "Mon Nov 16 12:02:00 2026",
    ])
        assert.equal(readPlayRetryAfterMs(retry, serverDate), 120000);
    assert.equal(
        readPlayRetryAfterMs(
            "Mon, 16 Nov 2026 12:02:00 GMT",
            "Mon Nov 16 12:00:00 2026",
        ),
        120000,
    );
});

test("Retry-After HTTP dates return zero for past or equal and clamp a future day", () => {
    for (const [raw, expected] of [
        ["Mon, 16 Nov 2026 11:59:00 GMT", 0],
        [serverDate, 0],
        ["Tue, 17 Nov 2026 12:00:01 GMT", 86400000],
    ] as const)
        assert.equal(readPlayRetryAfterMs(raw, serverDate), expected);
});

test("Retry-After requires a valid server Date and never consults the client clock", (context) => {
    context.mock.method(Date, "now", () => {
        throw new Error("client clock");
    });
    for (const rawServer of [
        undefined,
        null,
        1794830400000,
        "",
        "2026-11-16T12:00:00Z",
        "Monday, 16-Nov-26 12:00:00 GMT",
        "Tue, 16 Nov 2026 12:00:00 GMT",
    ])
        assert.equal(
            readPlayRetryAfterMs("Mon, 16 Nov 2026 12:02:00 GMT", rawServer),
            null,
        );
    assert.equal(
        readPlayRetryAfterMs(
            "Sun, 06 Nov 1994 08:51:37 GMT",
            "Sun, 06 Nov 1994 08:49:37 GMT",
        ),
        120000,
    );
});

test("Retry-After rejects invalid calendars, weekday, timezones, lists and date coercion", () => {
    for (const raw of [
        "Tue, 16 Nov 2026 12:02:00 GMT",
        "Mon, 31 Nov 2026 12:02:00 GMT",
        "Mon, 16 Nov 2026 24:00:00 GMT",
        "Mon, 16 Nov 2026 12:60:00 GMT",
        "Mon, 16 Nov 2026 12:00:61 GMT",
        "Mon, 16 Nov 2026 12:02:00 UTC",
        "Mon, 16 Nov 2026 12:02:00 +0000",
        "2026-11-16T12:02:00Z",
        "Mon, 16 Nov 2026 12:02:00 GMT, 120",
        "mon, 16 Nov 2026 12:02:00 GMT",
        "Mon, 16 Nov 2026 12:02:00 GMT\r\n",
    ])
        assert.equal(readPlayRetryAfterMs(raw, serverDate), null);
    assert.equal(
        readPlayRetryAfterMs("Wed, 29 Feb 2023 00:00:00 GMT", serverDate),
        null,
    );
    assert.equal(
        readPlayRetryAfterMs(
            "Thu, 29 Feb 2024 00:00:00 GMT",
            "Thu, 29 Feb 2024 00:00:00 GMT",
        ),
        0,
    );
});

test("Retry-After resolves obsolete two-digit years from the server rather than a fixed pivot", () => {
    assert.equal(
        readPlayRetryAfterMs("Wednesday, 16-Nov-77 12:00:00 GMT", serverDate),
        0,
    );
    assert.equal(
        readPlayRetryAfterMs("Monday, 16-Nov-76 12:00:00 GMT", serverDate),
        86400000,
    );
    assert.equal(
        readPlayRetryAfterMs(
            "Saturday, 31-Dec-16 23:59:60 GMT",
            "Sat, 31 Dec 2016 23:59:59 GMT",
        ),
        1000,
    );
});
