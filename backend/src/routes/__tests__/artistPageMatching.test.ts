import { filterDistinctDiscographyAlbums } from "../library/artistPageMatching";
import { albumMatchInputHash } from "../../services/remoteAlbumMatchInput";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const remote = () => {
    const row = {
        title: "Streaming title",
        rgMbid: "remote:stable",
        location: "REMOTE",
        artist: { name: "Artist", mbid: null },
        matchedRgMbid: first,
        rgMbidCheckedAt: new Date(),
        rgMbidMatchInputHash: "",
    };
    row.rgMbidMatchInputHash = albumMatchInputHash(row);
    return row;
};

describe("artist discography identity", () => {
    it("keeps distinct canonical release groups even when titles are identical", () => {
        const candidate = { title: "Orbit", rgMbid: second };
        expect(
            filterDistinctDiscographyAlbums(
                [{ title: "Orbit", rgMbid: first }],
                [candidate],
            ),
        ).toEqual([candidate]);
    });

    it("deduplicates the same canonical release group despite different titles", () => {
        expect(
            filterDistinctDiscographyAlbums(
                [{ title: "Library title", rgMbid: first }],
                [{ title: "Canonical title", rgMbid: first }],
            ),
        ).toEqual([]);
    });

    it("deduplicates only the fresh input-bound match of an existing REMOTE album", () => {
        expect(
            filterDistinctDiscographyAlbums(
                [remote()],
                [{ title: "Canonical title", rgMbid: first }],
            ),
        ).toEqual([]);
    });

    it.each(["unmatched", "stale", "renamed", "forged"])(
        "keeps the canonical acquisition card for a %s remote placeholder",
        (kind) => {
            const row = remote();
            row.title = "Orbit";
            row.rgMbidMatchInputHash = albumMatchInputHash(row);
            if (kind === "unmatched") row.matchedRgMbid = "";
            if (kind === "stale") row.rgMbidCheckedAt = new Date(0);
            if (kind === "renamed") row.title += " changed";
            if (kind === "forged") row.rgMbidMatchInputHash = "wrong";
            const candidate = { title: row.title, rgMbid: first };
            expect(filterDistinctDiscographyAlbums([row], [candidate])).toEqual(
                [candidate],
            );
        },
    );

    it("retains the legacy title fallback only when neither row has canonical identity", () => {
        expect(
            filterDistinctDiscographyAlbums(
                [{ title: "Orbit (Deluxe Edition)" }],
                [{ title: "Orbit" }],
            ),
        ).toEqual([]);
    });
});
