import {
    parseRecordingIdentityFromMetadataSearch,
    parseRecordingIsrcFromLookup,
    parseRecordingMbidFromIsrcLookup,
} from "../musicbrainzIdentity";

describe("MusicBrainz ISRC identity", () => {
    it("accepts one unambiguous recording MBID", () => {
        expect(
            parseRecordingMbidFromIsrcLookup({
                recordings: [{ id: "b9991644-7275-44db-bc43-fff6c6b4ce69" }],
            }),
        ).toBe("b9991644-7275-44db-bc43-fff6c6b4ce69");
    });

    it("rejects malformed and ambiguous ISRC mappings", () => {
        expect(
            parseRecordingMbidFromIsrcLookup({
                recordings: [
                    { id: "b9991644-7275-44db-bc43-fff6c6b4ce69" },
                    { id: "75c961c9-6e00-4861-9c9d-e6ca90d57342" },
                ],
            }),
        ).toBeNull();
        expect(parseRecordingMbidFromIsrcLookup({ recordings: [] })).toBeNull();
        expect(
            parseRecordingMbidFromIsrcLookup({ recordings: [{ id: "bad" }] }),
        ).toBeNull();
    });
});

describe("MusicBrainz metadata identity", () => {
    const studioMbid = "b9991644-7275-44db-bc43-fff6c6b4ce69";
    const liveMbid = "75c961c9-6e00-4861-9c9d-e6ca90d57342";

    it("accepts an exact artist/title/duration match and provider-noise suffix", () => {
        expect(
            parseRecordingIdentityFromMetadataSearch(
                {
                    recordings: [
                        {
                            id: studioMbid,
                            score: 100,
                            title: "Poker Face",
                            length: 214_000,
                            isrcs: ["US-UM7-08-24408"],
                            "artist-credit": [
                                { artist: { name: "Lady Gaga" } },
                            ],
                        },
                    ],
                },
                {
                    title: "Poker Face (Official Music Video)",
                    artist: "Lady Gaga",
                    duration: 214,
                },
            ),
        ).toEqual({
            recordingMbid: studioMbid,
            isrc: "USUM70824408",
            confidence: 0.96,
        });
    });

    it("uses duration to disambiguate otherwise identical recordings", () => {
        expect(
            parseRecordingIdentityFromMetadataSearch(
                {
                    recordings: [
                        {
                            id: studioMbid,
                            score: 100,
                            title: "Song",
                            length: 180_000,
                            "artist-credit": [{ name: "Artist" }],
                        },
                        {
                            id: liveMbid,
                            score: 100,
                            title: "Song",
                            length: 241_000,
                            "artist-credit": [{ name: "Artist" }],
                        },
                    ],
                },
                { title: "Song", artist: "Artist", duration: 180 },
            ),
        ).toEqual({
            recordingMbid: studioMbid,
            isrc: null,
            confidence: 0.94,
        });
    });

    it("rejects version mismatches and ambiguous recording rows", () => {
        expect(
            parseRecordingIdentityFromMetadataSearch(
                {
                    recordings: [
                        {
                            id: liveMbid,
                            score: 100,
                            title: "Song",
                            disambiguation: "live, 2024",
                            length: 180_000,
                            "artist-credit": [{ name: "Artist" }],
                        },
                    ],
                },
                { title: "Song", artist: "Artist", duration: 180 },
            ),
        ).toBeNull();

        expect(
            parseRecordingIdentityFromMetadataSearch(
                {
                    recordings: [
                        {
                            id: studioMbid,
                            score: 100,
                            title: "Song",
                            length: 180_000,
                            "artist-credit": [{ name: "Artist" }],
                        },
                        {
                            id: liveMbid,
                            score: 100,
                            title: "Song",
                            length: 181_000,
                            "artist-credit": [{ name: "Artist" }],
                        },
                    ],
                },
                { title: "Song", artist: "Artist", duration: 180 },
            ),
        ).toBeNull();
    });

    it("does not treat words containing live as a live-version marker", () => {
        expect(
            parseRecordingIdentityFromMetadataSearch(
                {
                    recordings: [
                        {
                            id: studioMbid,
                            score: 100,
                            title: "Deliver Us",
                            disambiguation: "live, 2024",
                            length: 180_000,
                            "artist-credit": [{ name: "Artist" }],
                        },
                    ],
                },
                { title: "Deliver Us", artist: "Artist", duration: 180 },
            ),
        ).toBeNull();
    });

    it("extracts one normalized ISRC from a recording lookup", () => {
        expect(
            parseRecordingIsrcFromLookup({
                id: studioMbid,
                isrcs: ["US-UM7-08-24408", "USUM70824408"],
            }),
        ).toBe("USUM70824408");
        expect(
            parseRecordingIsrcFromLookup({
                id: studioMbid,
                isrcs: ["USUM70824408", "GBAYE0601498"],
            }),
        ).toBeNull();
    });
});
