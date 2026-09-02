import { parseRecordingMbidFromIsrcLookup } from "../musicbrainzIdentity";

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
