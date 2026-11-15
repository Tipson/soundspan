import {
    assertPlayKeyCurrent,
    hashPlayCreationRequest,
    parsePlayCreationKey,
    classifyPlayAccountingFailure,
} from "../playAccountingProtocol";

const issuedAt = 1_700_000_000_000;
const key = `p1.7.${issuedAt.toString(36)}.${"A".repeat(32)}`;
const owner = { epoch: 7, prunedThrough: null };

test.each(["P1001", "P2024", "P2028", "P2034", "40P01"])(
    "transient %s has a bounded retryable 503 without its private message",
    (code) => {
        expect(
            classifyPlayAccountingFailure({
                code,
                message: "private fixture payload",
            }),
        ).toMatchObject({
            status: 503,
            code: "play_accounting_unavailable",
            message: "play_accounting_unavailable",
        });
    },
);
test("unrelated constraint and unknown failures are not disguised as transient", () => {
    expect(classifyPlayAccountingFailure({ code: "P2002" })).toBeNull();
    expect(classifyPlayAccountingFailure(new Error("unknown"))).toBeNull();
});

function expectFailure(work: () => unknown, status: number, code: string) {
    try {
        work();
        throw new Error("Expected a classified failure");
    } catch (error) {
        expect(error).toMatchObject({ status, code });
    }
}

test("one canonical key carries immutable epoch and expiry", () => {
    expect(parsePlayCreationKey(key)).toEqual({
        epoch: 7,
        issuedAtMs: issuedAt,
        expiresAtMs: 1_700_086_400_000,
    });
});

test.each([
    undefined,
    key + " ",
    key.replace("p1.", "p2."),
    key.replace("p1.7.", "p1.07."),
    `p1.7.${Number.MAX_SAFE_INTEGER.toString(36)}.${"A".repeat(32)}`,
    `p1.7.${issuedAt.toString(36)}.${"A".repeat(31)}`,
])(
    "unbounded or noncanonical key is rejected before admission: %p",
    (value) => {
        expectFailure(
            () => parsePlayCreationKey(value),
            400,
            "play_creation_invalid_key",
        );
    },
);

test("the replay window closes exactly at 24 hours", () => {
    const parsed = parsePlayCreationKey(key);
    expect(() =>
        assertPlayKeyCurrent(parsed, owner, 1_700_086_399_999),
    ).not.toThrow();
    expectFailure(
        () => assertPlayKeyCurrent(parsed, owner, 1_700_086_400_000),
        410,
        "play_key_expired",
    );
});

test("future admission is bounded to exactly five minutes", () => {
    const parsed = parsePlayCreationKey(key);
    expect(() =>
        assertPlayKeyCurrent(parsed, owner, issuedAt - 300_000),
    ).not.toThrow();
    expectFailure(
        () => assertPlayKeyCurrent(parsed, owner, issuedAt - 300_001),
        400,
        "play_creation_invalid_key",
    );
});

test("history epoch and prune floor still reject a key after clock rollback", () => {
    const parsed = parsePlayCreationKey(key);
    expectFailure(
        () =>
            assertPlayKeyCurrent(
                parsed,
                { epoch: 8, prunedThrough: null },
                issuedAt,
            ),
        410,
        "play_history_epoch_changed",
    );
    expectFailure(
        () =>
            assertPlayKeyCurrent(
                parsed,
                { epoch: 7, prunedThrough: new Date(issuedAt) },
                issuedAt,
            ),
        410,
        "play_key_pruned",
    );
});

test("hash normalizes validated fields but preserves the accepted source snapshot", () => {
    const recording = {
        provider: "vk",
        id: "-1_2",
        title: "Title",
        artists: ["Artist"],
        duration: 200,
        contentVersion: "unknown",
        preview: false,
    };
    const first = hashPlayCreationRequest({
        musicSourceRecording: recording,
        playContext: "wave",
    });
    const reordered = hashPlayCreationRequest({
        playContext: "wave",
        musicSourceRecording: { ...recording },
        clientPlaybackId: "not-payload",
        unused: "not-accepted",
    });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered).toBe(first);
    expect(
        hashPlayCreationRequest({
            musicSourceRecording: { ...recording, title: "Other" },
            playContext: "wave",
        }),
    ).not.toBe(first);
    expect(
        hashPlayCreationRequest({
            musicSourceRecording: recording,
            playContext: "search",
        }),
    ).not.toBe(first);
});
