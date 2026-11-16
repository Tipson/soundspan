import {
    decodeScrobbleDispatchAck,
    playScrobbleDispatchId,
    scrobbleDispatchWakeSchema,
} from "../../playScrobbleProtocol";

describe("durable scrobble v1 wire boundary", () => {
    test("dispatch identity binds the original Play, connection and auth epoch", () => {
        const one = playScrobbleDispatchId("play", "connection", 7);
        expect(one).toMatch(/^[a-f0-9]{64}$/);
        expect(playScrobbleDispatchId("play", "connection", 7)).toBe(one);
        expect(playScrobbleDispatchId("play", "connection", 8)).not.toBe(one);
        expect(playScrobbleDispatchId("play", "other", 7)).not.toBe(one);
    });

    test("a wake job cannot be confused with the legacy metadata payload", () => {
        expect(
            scrobbleDispatchWakeSchema.safeParse({
                version: 1,
                dispatchId: "a".repeat(64),
                userId: "owner",
            }).success,
        ).toBe(true);
        expect(
            scrobbleDispatchWakeSchema.safeParse({
                service: "lastfm",
                userId: "owner",
                kind: "scrobble",
                track: {},
            }).success,
        ).toBe(false);
        expect(
            scrobbleDispatchWakeSchema.safeParse({
                version: 1,
                dispatchId: "a".repeat(64),
                userId: "owner",
                credential: "must not enter queue",
            }).success,
        ).toBe(false);
    });

    test.each([null, "", "<html>ok</html>", {}, { status: "unknown" }])(
        "ListenBrainz200 is not enough for success: %p",
        (data) => {
            expect(decodeScrobbleDispatchAck("listenbrainz", 200, data)).toBe(
                "ambiguous",
            );
        },
    );

    test("only the bounded ListenBrainz success ACK completes a dispatch", () => {
        expect(
            decodeScrobbleDispatchAck("listenbrainz", 200, { status: "ok" }),
        ).toBe("submitted");
        expect(
            decodeScrobbleDispatchAck("listenbrainz", 401, {
                error: "private provider detail",
            }),
        ).toBe("invalid_auth");
    });

    test("Last.fm accepted and ignored responses remain distinct terminal outcomes", () => {
        expect(
            decodeScrobbleDispatchAck("lastfm", 200, {
                scrobbles: {
                    "@attr": { accepted: "1", ignored: "0" },
                    scrobble: { ignoredMessage: { code: "0", "#text": "" } },
                },
            }),
        ).toBe("submitted");
        expect(
            decodeScrobbleDispatchAck("lastfm", 200, {
                scrobbles: {
                    "@attr": { accepted: "0", ignored: "1" },
                    scrobble: {
                        ignoredMessage: { code: "1", "#text": "ignored" },
                    },
                },
            }),
        ).toBe("rejected");
        expect(
            decodeScrobbleDispatchAck("lastfm", 200, {
                error: 9,
                message: "private provider detail",
            }),
        ).toBe("invalid_auth");
    });

    test.each([
        {},
        { scrobbles: {} },
        { scrobbles: { "@attr": { accepted: "1", ignored: "1" } } },
    ])("Last.fm malformed ACK is never submitted: %p", (data) => {
        expect(decodeScrobbleDispatchAck("lastfm", 200, data)).toBe(
            "ambiguous",
        );
    });

    test("contradictory Last.fm error and accepted counters never acknowledge submission", () => {
        const scrobbles = {
            "@attr": { accepted: "1", ignored: "0" },
            scrobble: { ignoredMessage: { code: "0" } },
        };
        expect(
            decodeScrobbleDispatchAck("lastfm", 200, { error: 16, scrobbles }),
        ).toBe("ambiguous");
        expect(
            decodeScrobbleDispatchAck("lastfm", 200, { error: 9, scrobbles }),
        ).toBe("ambiguous");
    });

    test.each([429, 500, 503])(
        "post-handoff HTTP%s never grants an automatic provider retry",
        (status) => {
            expect(
                decodeScrobbleDispatchAck("lastfm", status, { status: "ok" }),
            ).toBe("ambiguous");
            expect(
                decodeScrobbleDispatchAck("listenbrainz", status, {
                    status: "ok",
                }),
            ).toBe("ambiguous");
        },
    );
});
