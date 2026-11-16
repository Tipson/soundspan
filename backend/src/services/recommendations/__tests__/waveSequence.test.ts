import {
    createWaveSequenceContext,
    encodeWaveSequenceCursor,
    parseWaveSequenceCursor,
    validateWaveSequenceContinuation,
    WaveSequenceError,
    type WaveSequenceContextV1,
    type WaveSequenceIntent,
    type WaveSequenceReference,
} from "../waveSequence";
import { toNativeRecommendationCandidate } from "../nativeCandidates";
import type { ScoredRecommendation } from "../types";

const sequenceId = "7fd3f490-c1c2-4d98-9d9f-955c587e0398";
const intent: WaveSequenceIntent = {
    direction: "for-you",
    mood: null,
    language: "any",
};
const createdAt = new Date("2026-11-17T00:00:00Z");
const now = new Date("2026-11-17T01:00:00Z");

function row(id: string, artist = "A"): ScoredRecommendation {
    return {
        score: 17,
        track: {
            id,
            canonicalKey: `local:${id}`,
            title: id,
            duration: 180,
            artist: { id: null, name: artist },
            album: { id: null, title: "", coverArt: null },
            source: "library",
            streamSource: "library",
            provider: { youtubeVideoId: null, tidalTrackId: null },
            candidateSources: ["library"],
            providerPrior: 1,
        },
    };
}

function context(): WaveSequenceContextV1 {
    return {
        version: 1,
        sequenceId,
        nextPosition: 3,
        nextSourceCursor: 25,
        intent: { ...intent },
        tail: [
            { source: "library", id: "b", position: 1, artistKey: "b" },
            { source: "library", id: "c", position: 2, artistKey: "c" },
        ],
    };
}

function clientTail(stored = context()): WaveSequenceReference[] {
    return stored.tail.map(({ source, id, position }) => ({
        source,
        id,
        position,
    }));
}

function continuation(stored = context()) {
    return {
        cursor: {
            version: 1 as const,
            generationId: "cm-served-generation",
            sequenceId,
            nextPosition: stored.nextPosition,
            nextSourceCursor: stored.nextSourceCursor,
        },
        tail: clientTail(stored),
        generation: {
            id: "cm-served-generation",
            userId: "owner",
            sessionId: "wave-session",
            surface: "wave",
            served: true,
            createdAt,
            context: { orderedWave: stored, unrelatedNamespace: true },
        },
        userId: "owner",
        sessionId: "wave-session",
        intent: { ...intent },
        now,
    };
}

function expectCode(operation: () => unknown, code: WaveSequenceError["code"]) {
    try {
        operation();
        throw new Error("Expected a WaveSequenceError");
    } catch (error) {
        expect(error).toBeInstanceOf(WaveSequenceError);
        expect((error as WaveSequenceError).code).toBe(code);
    }
}

describe("server-owned Wave sequence protocol", () => {
    it("records ordered occurrences and only two normalized server artist positions", () => {
        const ordered = [row("a1", "A"), row("a2", "Ａ"), row("b", " Б ")];
        const before = structuredClone(ordered);
        const result = createWaveSequenceContext({
            ordered,
            sequenceId,
            startPosition: 0,
            nextSourceCursor: 25,
            verifiedPreviousTail: [],
            intent,
        });
        expect(result).toEqual({
            version: 1,
            sequenceId,
            nextPosition: 3,
            nextSourceCursor: 25,
            intent,
            tail: [
                { source: "library", id: "a2", position: 1, artistKey: "a" },
                { source: "library", id: "b", position: 2, artistKey: "б" },
            ],
        });
        expect(ordered).toEqual(before);
        expect(result.intent).not.toBe(intent);
    });

    it("retains verified previous positions across a one-song or empty page", () => {
        const previous = context().tail;
        const one = createWaveSequenceContext({
            ordered: [row("d", "Unknown Artist")],
            sequenceId,
            startPosition: 3,
            nextSourceCursor: 50,
            verifiedPreviousTail: previous,
            intent,
        });
        expect(one.tail).toEqual([
            { source: "library", id: "c", position: 2, artistKey: "c" },
            { source: "library", id: "d", position: 3, artistKey: null },
        ]);
        const empty = createWaveSequenceContext({
            ordered: [],
            sequenceId,
            startPosition: 3,
            nextSourceCursor: 50,
            verifiedPreviousTail: previous,
            intent,
        });
        expect(empty.tail).toEqual(previous);
        expect(empty.tail).not.toBe(previous);
        expect(
            createWaveSequenceContext({
                ordered: [],
                sequenceId,
                startPosition: 0,
                nextSourceCursor: 0,
                verifiedPreviousTail: [],
                intent,
            }).tail,
        ).toEqual([]);
    });

    it("rejects ambiguous library and Youtube backing instead of recording a different source", () => {
        const local = row("local-real");
        local.track.provider.youtubeVideoId = "abcdefghijk";
        local.track.youtubeVideoId = "abcdefghijk";
        expect(() =>
            createWaveSequenceContext({
                ordered: [local],
                sequenceId,
                startPosition: 0,
                nextSourceCursor: 1,
                verifiedPreviousTail: [],
                intent,
            }),
        ).toThrow(WaveSequenceError);
    });

    it("retains exact Youtube, Tidal, VK and Yandex recording references", () => {
        const youtube = row("yt:abcdefghijk");
        Object.assign(youtube.track, {
            source: "youtube",
            streamSource: "youtube",
            provider: { youtubeVideoId: "abcdefghijk", tidalTrackId: null },
        });
        const tidal = row("tidal:42");
        Object.assign(tidal.track, {
            source: "tidal",
            streamSource: "tidal",
            provider: { youtubeVideoId: null, tidalTrackId: 42 },
        });
        for (const [provider, id] of [
            ["vk", "-42_13"],
            ["yandex", "123"],
        ] as const) {
            const native = toNativeRecommendationCandidate(
                {
                    provider,
                    id,
                    title: "Song",
                    artists: ["Artist"],
                    duration: 180,
                    contentVersion: "unknown",
                    preview: false,
                },
                "test",
            )!;
            expect(
                createWaveSequenceContext({
                    ordered: [{ track: native, score: 0 }],
                    sequenceId,
                    startPosition: 0,
                    nextSourceCursor: 1,
                    verifiedPreviousTail: [],
                    intent,
                }).tail[0],
            ).toEqual({
                source: provider,
                id,
                position: 0,
                artistKey: "artist",
            });
        }
        expect(
            createWaveSequenceContext({
                ordered: [youtube, tidal],
                sequenceId,
                startPosition: 0,
                nextSourceCursor: 2,
                verifiedPreviousTail: [],
                intent,
            }).tail.map(({ source, id }) => ({ source, id })),
        ).toEqual([
            { source: "youtube", id: "abcdefghijk" },
            { source: "tidal", id: "42" },
        ]);
    });

    it("encodes only the persisted generation locator without artist or owner authority", () => {
        const encoded = encodeWaveSequenceCursor(
            "cm-served-generation",
            context(),
        );
        expect(encoded.length).toBeLessThanOrEqual(1024);
        expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(parseWaveSequenceCursor(encoded)).toEqual({
            version: 1,
            generationId: "cm-served-generation",
            sequenceId,
            nextPosition: 3,
            nextSourceCursor: 25,
        });
        expect(
            JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
        ).toEqual({
            version: 1,
            generationId: "cm-served-generation",
            sequenceId,
            nextPosition: 3,
            nextSourceCursor: 25,
        });
    });

    it("trusts server history only after the entire exact ordered request tail", () => {
        const input = continuation();
        const before = structuredClone(input);
        const result = validateWaveSequenceContinuation(input);
        expect(result).toEqual(context());
        expect(result).not.toBe(input.generation.context.orderedWave);
        expect(result.tail[0]).not.toBe(
            input.generation.context.orderedWave.tail[0],
        );
        expect(input).toEqual(before);
    });

    it.each(["userId", "sessionId", "surface", "served", "id"] as const)(
        "rejects a generation with mismatched %s before trusting its history",
        (field) => {
            const input = continuation();
            Object.assign(input.generation, {
                [field]: field === "served" ? false : "foreign",
            });
            expectCode(
                () => validateWaveSequenceContinuation(input),
                "invalid_cursor",
            );
        },
    );

    it.each([
        "sequenceId",
        "nextPosition",
        "nextSourceCursor",
        "generationId",
    ] as const)(
        "rejects cursor %s tampering against the server row",
        (field) => {
            const input = continuation();
            Object.assign(input.cursor, {
                [field]:
                    field === "nextPosition" || field === "nextSourceCursor"
                        ? 77
                        : "7fd3f490-c1c2-4d98-9d9f-955c587e0399",
            });
            expectCode(
                () => validateWaveSequenceContinuation(input),
                "invalid_cursor",
            );
        },
    );

    it.each([
        [
            "reordered",
            [
                { source: "library", id: "c", position: 2 },
                { source: "library", id: "b", position: 1 },
            ],
        ],
        [
            "duplicate",
            [
                { source: "library", id: "c", position: 2 },
                { source: "library", id: "c", position: 2 },
            ],
        ],
        ["not suffix", [{ source: "library", id: "b", position: 1 }]],
        ["incomplete suffix", [{ source: "library", id: "c", position: 2 }]],
        [
            "wrong source",
            [{ source: "youtube", id: "abcdefghijk", position: 2 }],
        ],
        ["wrong position", [{ source: "library", id: "c", position: 1 }]],
        [
            "artist authority",
            [{ source: "library", id: "c", position: 2, artistKey: "forged" }],
        ],
        [
            "extra field",
            [{ source: "library", id: "c", position: 2, sequenceId }],
        ],
        ["empty continuation", []],
        [
            "oversize",
            Array.from({ length: 3 }, () => ({
                source: "library",
                id: "c",
                position: 2,
            })),
        ],
        ["non array", { source: "library", id: "c", position: 2 }],
    ])("rejects %s client tail", (_name, tail) => {
        expectCode(
            () => validateWaveSequenceContinuation({ ...continuation(), tail }),
            "invalid_tail",
        );
    });

    it.each(["direction", "mood", "language"] as const)(
        "requires reset after %s changes",
        (field) => {
            const input = continuation();
            Object.assign(input.intent, {
                [field]:
                    field === "direction"
                        ? "new"
                        : field === "language"
                          ? "ru"
                          : "calm",
            });
            expectCode(
                () => validateWaveSequenceContinuation(input),
                "intent_changed",
            );
        },
    );

    it("expires at24h from the trusted generation timestamp", () => {
        const input = continuation();
        expectCode(
            () =>
                validateWaveSequenceContinuation({
                    ...input,
                    now: new Date(createdAt.getTime() + 86400000),
                }),
            "expired",
        );
        expect(
            validateWaveSequenceContinuation({
                ...input,
                now: new Date(createdAt.getTime() + 86399999),
            }),
        ).toEqual(context());
    });

    it.each([
        "",
        "a".repeat(1025),
        "%%%",
        "e30=",
        "e30+",
        "e30",
        Buffer.from('{"version":2}').toString("base64url"),
    ])("rejects malformed or oversize cursor %s", (raw) =>
        expectCode(() => parseWaveSequenceCursor(raw), "invalid_cursor"),
    );

    it("rejects malformed persisted namespace and noncontiguous server tail", () => {
        for (const orderedWave of [
            null,
            { ...context(), version: 2 },
            { ...context(), tail: [] },
            {
                ...context(),
                tail: [
                    { source: "library", id: "c", position: 0, artistKey: "c" },
                ],
            },
            { ...context(), extra: true },
            {
                ...context(),
                tail: [
                    ...context().tail,
                    { source: "library", id: "d", position: 3, artistKey: "d" },
                ],
            },
        ]) {
            const input = continuation();
            input.generation.context = {
                orderedWave,
                unrelatedNamespace: true,
            } as typeof input.generation.context;
            expectCode(
                () => validateWaveSequenceContinuation(input),
                "invalid_cursor",
            );
        }
    });

    it("fails the complete page instead of dropping an unreferenceable admitted row", () => {
        const invalid = row("bad/id");
        expectCode(
            () =>
                createWaveSequenceContext({
                    ordered: [invalid, row("a"), row("b")],
                    sequenceId,
                    startPosition: 0,
                    nextSourceCursor: 1,
                    verifiedPreviousTail: [],
                    intent,
                }),
            "invalid_tail",
        );
        const badYoutube = row("yt:short");
        Object.assign(badYoutube.track, {
            source: "youtube",
            streamSource: "youtube",
            provider: { youtubeVideoId: "short", tidalTrackId: null },
        });
        expectCode(
            () =>
                createWaveSequenceContext({
                    ordered: [badYoutube],
                    sequenceId,
                    startPosition: 0,
                    nextSourceCursor: 1,
                    verifiedPreviousTail: [],
                    intent,
                }),
            "invalid_tail",
        );
    });

    it("bounds pages and positions without mutating its input", () => {
        const ordered = Array.from({ length: 75 }, (_, i) => row(`track-${i}`));
        expect(
            createWaveSequenceContext({
                ordered,
                sequenceId,
                startPosition: 0,
                nextSourceCursor: 75,
                verifiedPreviousTail: [],
                intent,
            }).nextPosition,
        ).toBe(75);
        expectCode(
            () =>
                createWaveSequenceContext({
                    ordered: [...ordered, row("overflow")],
                    sequenceId,
                    startPosition: 0,
                    nextSourceCursor: 76,
                    verifiedPreviousTail: [],
                    intent,
                }),
            "invalid_tail",
        );
        expectCode(
            () =>
                createWaveSequenceContext({
                    ordered: [row("a")],
                    sequenceId,
                    startPosition: Number.MAX_SAFE_INTEGER,
                    nextSourceCursor: 1,
                    verifiedPreviousTail: [],
                    intent,
                }),
            "invalid_cursor",
        );
    });

    it("honors the shared check during creation and validation without a new timer", () => {
        const stopped = new Error("request cancelled");
        let checks = 0;
        expect(() =>
            createWaveSequenceContext({
                ordered: [row("a"), row("b"), row("c")],
                sequenceId,
                startPosition: 0,
                nextSourceCursor: 3,
                verifiedPreviousTail: [],
                intent,
                check: () => {
                    if (++checks === 3) throw stopped;
                },
            }),
        ).toThrow(stopped);
        expect(() =>
            validateWaveSequenceContinuation({
                ...continuation(),
                check: () => {
                    throw stopped;
                },
            }),
        ).toThrow(stopped);
    });

    it.each([
        { source: "library", id: "bad/id", position: 2 },
        { source: "youtube", id: "short", position: 2 },
        { source: "tidal", id: "9007199254740992", position: 2 },
        { source: "vk", id: "1:2", position: 2 },
        { source: "yandex", id: "0", position: 2 },
    ])("fails closed on malformed provider reference $source", (ref) => {
        expectCode(
            () =>
                validateWaveSequenceContinuation({
                    ...continuation(),
                    tail: [clientTail()[0], ref],
                }),
            "invalid_tail",
        );
    });

    it.each([
        { nextPosition: -1 },
        { nextPosition: 1.5 },
        { nextSourceCursor: -1 },
        { nextSourceCursor: Number.MAX_SAFE_INTEGER + 1 },
        { generationId: "path/to/id" },
        { sequenceId: "not-a-uuid" },
        { owner: "client-asserted-owner" },
    ])("rejects malformed structured cursor %j", (extra) => {
        const raw = Buffer.from(
            JSON.stringify({ ...continuation().cursor, ...extra }),
        ).toString("base64url");
        expectCode(() => parseWaveSequenceCursor(raw), "invalid_cursor");
    });

    it("keeps an empty first generation valid with an exact empty tail", () => {
        const stored = {
            ...context(),
            nextPosition: 0,
            nextSourceCursor: 0,
            tail: [],
        };
        expect(validateWaveSequenceContinuation(continuation(stored))).toEqual(
            stored,
        );
    });

    it("rejects overlong stored JSON and malformed server artist credits", () => {
        const stored = context();
        stored.tail[0].artistKey = "а".repeat(513);
        expectCode(
            () => validateWaveSequenceContinuation(continuation(stored)),
            "invalid_cursor",
        );
        const unnormalized = context();
        unnormalized.tail[0].artistKey = "Client Artist";
        expectCode(
            () => validateWaveSequenceContinuation(continuation(unnormalized)),
            "invalid_cursor",
        );
        const extra = continuation();
        extra.tail = [
            { ...extra.tail[0], artistNames: "x".repeat(10000) },
            extra.tail[1],
        ] as typeof extra.tail;
        expectCode(
            () => validateWaveSequenceContinuation(extra),
            "invalid_tail",
        );
    });

    it("propagates cancellation from cursor parsing and encoding", () => {
        const stopped = new Error("request deadline");
        const raw = Buffer.from(JSON.stringify(continuation().cursor)).toString(
            "base64url",
        );
        expect(() =>
            parseWaveSequenceCursor(raw, () => {
                throw stopped;
            }),
        ).toThrow(stopped);
        expect(() =>
            encodeWaveSequenceCursor("cm-served-generation", context(), () => {
                throw stopped;
            }),
        ).toThrow(stopped);
    });

    it("rejects sequence positions beyond the persisted exposure Int before write", () => {
        const maximum = 2_147_483_647;
        const verifiedPreviousTail = [
            {
                source: "library" as const,
                id: "before-a",
                position: maximum - 2,
                artistKey: "a",
            },
            {
                source: "library" as const,
                id: "before-b",
                position: maximum - 1,
                artistKey: "b",
            },
        ];
        expectCode(
            () =>
                createWaveSequenceContext({
                    ordered: [row("next")],
                    sequenceId,
                    startPosition: maximum,
                    nextSourceCursor: 75,
                    verifiedPreviousTail,
                    intent,
                }),
            "invalid_cursor",
        );
        const raw = Buffer.from(
            JSON.stringify({
                ...continuation().cursor,
                nextPosition: maximum + 1,
            }),
        ).toString("base64url");
        expectCode(() => parseWaveSequenceCursor(raw), "invalid_cursor");
    });
});
