import { parsePlayCreationRollout } from "../playCreationRollout";

test.each([undefined, "", "off", "all", "true", "unknown"])(
    "inactive or unknown mode %s cannot enable Play creation/replay",
    (mode) => {
        expect(parsePlayCreationRollout(mode, "alice")).toEqual({
            newCreationsEnabled: false,
            replaySupported: false,
            newCreationUserIds: [],
        });
    },
);

test("cohort mode preserves exact IDs, trims delimiters and deduplicates", () => {
    expect(
        parsePlayCreationRollout("cohort", "alice, Alice ,bob,alice"),
    ).toEqual({
        newCreationsEnabled: true,
        replaySupported: true,
        newCreationUserIds: ["alice", "Alice", "bob"],
    });
});

test.each([
    undefined,
    "",
    " ",
    "*",
    "alice,*",
    "alice,,bob",
    "alice,",
    ",alice",
    "alice bob",
    "alice/bob",
    "alice\nbob",
    "алиса",
    "a".repeat(129),
    Array.from({ length: 257 }, (_, i) => `user-${i}`).join(","),
    "a".repeat(41 * 1024),
])(
    "invalid/empty/bounded cohort %p denies all new creation but retains replay",
    (users) => {
        expect(parsePlayCreationRollout("cohort", users)).toEqual({
            newCreationsEnabled: false,
            replaySupported: true,
            newCreationUserIds: [],
        });
    },
);

test.each([undefined, "", "*", "a".repeat(41 * 1024)])(
    "producer rollback preserves replay regardless of the cohort setting",
    (users) => {
        expect(parsePlayCreationRollout("replay", users)).toEqual({
            newCreationsEnabled: false,
            replaySupported: true,
            newCreationUserIds: [],
        });
    },
);

test("the bounded cohort accepts256 IDs and128-character IDs without truncation", () => {
    const ids = [
        "a".repeat(128),
        ...Array.from({ length: 255 }, (_, i) => `user_${i}`),
    ];
    const policy = parsePlayCreationRollout("cohort", ids.join(","));
    expect(policy.newCreationsEnabled).toBe(true);
    expect(policy.newCreationUserIds).toEqual(ids);
    expect(() =>
        (policy.newCreationUserIds as string[]).push("mallory"),
    ).toThrow();
    expect(policy.newCreationUserIds).toHaveLength(256);
});

test("the raw cohort budget counts UTF8 bytes before trimming Unicode whitespace", () => {
    const cohort = "\u2003".repeat(15_000) + "Alice";
    expect(Buffer.byteLength(cohort, "utf8")).toBeGreaterThan(40 * 1024);
    expect(parsePlayCreationRollout("cohort", cohort)).toEqual({
        newCreationsEnabled: false,
        replaySupported: true,
        newCreationUserIds: [],
    });
});
