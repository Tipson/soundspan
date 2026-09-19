import {
    DEFAULT_PLAYBACK_SOURCE_ORDER,
    parsePlaybackSourceOrder,
    rankPlaybackSource,
} from "../playbackSourcePriority";

describe("playback source priority", () => {
    it.each([
        ["library", true, 400],
        ["peers", true, 300],
        ["ytmusic", true, 200],
        ["peers", false, 100],
    ] as const)("ranks %s availability=%s", (source, available, expected) => {
        expect(
            rankPlaybackSource(
                { source, available },
                DEFAULT_PLAYBACK_SOURCE_ORDER,
            ),
        ).toBe(expected);
    });

    it("honors a valid configured provider order", () => {
        const order = parsePlaybackSourceOrder("ytmusic,peers,library");

        expect(
            rankPlaybackSource({ source: "ytmusic", available: true }, order),
        ).toBeGreaterThan(
            rankPlaybackSource({ source: "library", available: true }, order),
        );
    });

    it("falls back to the default for malformed stored values", () => {
        const order = parsePlaybackSourceOrder("library,unknown,ytmusic");

        expect(order).toEqual(DEFAULT_PLAYBACK_SOURCE_ORDER);
    });

    it("removes the retired TIDAL tier from a complete legacy order", () => {
        const order = parsePlaybackSourceOrder("ytmusic,tidal,peers,library");

        expect(order).toEqual(["ytmusic", "peers", "library"]);
    });
});
