import {
    pickRemoteAlbumMbidMatch,
    remoteAlbumTitleTier,
} from "../remoteAlbumMbidMatch";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const candidate = (rgMbid = a, extra = {}) => ({
    rgMbid,
    title: "Album",
    primaryType: "Album",
    artistMatches: true,
    score: 100,
    ...extra,
});

describe("conservative REMOTE album release-group matching", () => {
    it("selects one exact identity before an edition and deduplicates one RG", () => {
        expect(
            pickRemoteAlbumMbidMatch(
                "Album",
                [
                    candidate(a, { title: "Album (Deluxe Edition)" }),
                    candidate(b),
                    candidate(b),
                ],
                { allowSingle: false },
            )?.rgMbid,
        ).toBe(b);
    });
    it("rejects distinct RG ambiguity regardless of provider order", () => {
        for (const rows of [
            [candidate(a), candidate(b)],
            [candidate(b), candidate(a)],
        ])
            expect(
                pickRemoteAlbumMbidMatch("Album", rows, { allowSingle: false }),
            ).toBeNull();
    });
    it.each([
        "Album (Live)",
        "Album (Remix)",
        "Album (Acoustic)",
        "Album (Live Deluxe Edition)",
    ])("preserves musical version %s", (title) => {
        expect(remoteAlbumTitleTier("Album", title)).toBeNull();
    });
    it.each([
        "Album (Deluxe Edition)",
        "Album [2019 Remaster]",
        "Album - Expanded Edition",
    ])("accepts narrow edition %s", (title) => {
        expect(remoteAlbumTitleTier("Album", title)).toBe("edition");
    });
    it("rejects incompatible MB secondary version even when its title matches", () => {
        expect(
            pickRemoteAlbumMbidMatch(
                "Album",
                [candidate(a, { secondaryTypes: ["Live"] })],
                { allowSingle: false },
            ),
        ).toBeNull();
        expect(
            pickRemoteAlbumMbidMatch(
                "Album (Live)",
                [
                    candidate(a, {
                        title: "Album (Live)",
                        secondaryTypes: ["Live"],
                    }),
                ],
                { allowSingle: false },
            )?.rgMbid,
        ).toBe(a);
    });
    it.each([
        { artistMatches: false },
        { rgMbid: "remote:x" },
        { score: 89 },
        { score: Number.NaN },
        { primaryType: "Broadcast" },
    ])("rejects ineligible identity %j", (extra) => {
        expect(
            pickRemoteAlbumMbidMatch("Album", [candidate(a, extra)], {
                allowSingle: false,
            }),
        ).toBeNull();
    });
    it("does not downgrade a weak exact candidate to a strong edition", () => {
        expect(
            pickRemoteAlbumMbidMatch(
                "Album",
                [
                    candidate(a, { score: 89 }),
                    candidate(b, { title: "Album (Deluxe Edition)" }),
                ],
                { allowSingle: false },
            ),
        ).toBeNull();
    });
    it("allows Single only with explicit track-title evidence", () => {
        const rows = [candidate(a, { primaryType: "Single" })];
        expect(
            pickRemoteAlbumMbidMatch("Album", rows, { allowSingle: false }),
        ).toBeNull();
        expect(
            pickRemoteAlbumMbidMatch("Album", rows, { allowSingle: true })
                ?.rgMbid,
        ).toBe(a);
    });
    it("bounds repeated and oversized edition suffixes", () => {
        expect(
            remoteAlbumTitleTier(
                "Album",
                "Album" + " (Deluxe Edition)".repeat(4),
            ),
        ).toBeNull();
        expect(
            remoteAlbumTitleTier(
                "Album",
                "Album (" + "Deluxe ".repeat(100) + "Edition)",
            ),
        ).toBeNull();
    });
});
