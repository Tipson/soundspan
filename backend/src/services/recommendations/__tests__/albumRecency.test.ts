import { rankRecommendationCandidates } from "../rankerV2";
import { buildRecommendationAlbumKey } from "../identityKeys";
import type {
    RecommendationCandidate,
    RecommendationExposureSignal,
} from "../types";

const now = new Date("2026-09-05T12:00:00Z");
const day = 86_400_000;
function candidate(
    id: string,
    artist = "Artist",
    album = "Album",
): RecommendationCandidate {
    return {
        id,
        canonicalKey: id,
        title: id,
        duration: 180,
        artist: { id: null, name: artist },
        album: { id: null, title: album, coverArt: null },
        source: "youtube",
        streamSource: "youtube",
        provider: { tidalTrackId: null, youtubeVideoId: id },
        candidateSources: [],
        providerPrior: 1,
    };
}
const history = (age = 0) => ({
    canonicalKey: "previous-recording",
    albumKey: JSON.stringify(["artist", "album"]),
    exposedAt: new Date(now.getTime() - age),
});
function rank(
    candidates: RecommendationCandidate[],
    exposures: RecommendationExposureSignal[],
    extra = {},
) {
    return rankRecommendationCandidates(candidates, {
        now,
        limit: 10,
        sessionId: "album-history",
        direction: "familiar",
        mood: null,
        dislikedCanonicalKeys: new Set(),
        positiveCentroids: [],
        negativeCentroids: [],
        exposures,
        ...extra,
    });
}

describe("historical album recency", () => {
    it.each(["", " Single ", "UNKNOWN", " Unknown   Album "])(
        "does not create an identity for the placeholder %s",
        (album) => {
            expect(buildRecommendationAlbumKey("Artist", album)).toBeNull();
            const ownPlaceholderHistory = {
                ...history(),
                albumKey: JSON.stringify([
                    "artist",
                    album.trim().toLowerCase(),
                ]),
            };
            expect(
                rank(
                    [candidate("neutral", "Artist", album)],
                    [ownPlaceholderHistory],
                )[0].score,
            ).toBe(1);
        },
    );

    it("encodes ambiguous delimiters without joining distinct artist/releases", () => {
        expect(buildRecommendationAlbumKey("a:b", "c")).not.toBe(
            buildRecommendationAlbumKey("a", "b:c"),
        );
        expect(
            buildRecommendationAlbumKey("Unknown Artist", "Album"),
        ).toBeNull();
    });

    it("rotates to another album by the same artist without excluding the repeated album", () => {
        const repeated = { ...candidate("repeat"), providerPrior: 1.1 };
        expect(
            rank(
                [repeated, candidate("fresh", "Artist", "Other Album")],
                [history()],
            ).map(({ track }) => track.id),
        ).toEqual(["fresh", "repeat"]);
    });

    it("uses a bounded latest-only penalty that decays to zero over the existing day window", () => {
        const item = candidate("repeat");
        const score = (rows: RecommendationExposureSignal[]) =>
            rank([item], rows)[0].score;
        expect(score([history()])).toBeCloseTo(1 - 0.42);
        expect(score([history(day / 2)])).toBeCloseTo(1 - 0.21);
        expect(score([history(day)])).toBe(1);
        expect(score([history(day * 2)])).toBe(1);
        expect(score([history(), history(), history(day / 2)])).toBe(
            score([history()]),
        );
        expect(score([history(day / 2), history()])).toBe(score([history()]));
    });

    it.each([
        ["Other Artist", "Album"],
        ["Artist", "Other Album"],
        ["Artist", "Single"],
        ["Artist", "Unknown Album"],
        ["Artist", ""],
    ])(
        "does not conflate unknown or different album identity: %s / %s",
        (artist, album) => {
            const item = candidate("neutral", artist, album);
            expect(rank([item], [history()])).toEqual(rank([item], []));
        },
    );

    it("normalizes artist and album identity consistently across metadata variants", () => {
        expect(
            rank(
                [candidate("repeat", " ＡＲＴＩＳＴ ", "  ALBUM  ")],
                [history()],
            )[0].score,
        ).toBeCloseTo(1 - 0.42);
    });

    it("keeps legacy history and invalid dates neutral, and future dates bounded", () => {
        const item = candidate("repeat");
        expect(
            rank([item], [{ canonicalKey: "old", exposedAt: now }])[0].score,
        ).toBe(1);
        expect(
            rank([item], [{ ...history(), exposedAt: new Date(NaN) }])[0].score,
        ).toBe(1);
        expect(rank([item], [history(-day)])[0].score).toBeCloseTo(1 - 0.42);
    });

    it("retains a small all-repeated playable pool, cooldown backfill and strong favorites", () => {
        const items = [candidate("one"), candidate("two")];
        const exposures = items.map((item) => ({
            ...history(),
            canonicalKey: item.canonicalKey,
        }));
        expect(
            rank(items, exposures)
                .map(({ track }) => track.id)
                .sort(),
        ).toEqual(["one", "two"]);
        const favorite = { ...candidate("favorite"), accountAffinity: 1 };
        expect(
            rank(
                [candidate("fresh", "Other", "Fresh"), favorite],
                [history()],
            )[0].track.id,
        ).toBe("favorite");
    });

    it("does not stack duplicate rows on top of existing artist recency or change inputs across calls", () => {
        const item = candidate("repeat");
        const exposure = { ...history(), artistKey: "artist" };
        const baseline = rank(
            [item],
            [{ canonicalKey: "old", artistKey: "artist", exposedAt: now }],
        );
        const snapshot = structuredClone({ item, exposure });
        const result = rank([item], [exposure, exposure]);
        expect(baseline[0].score - result[0].score).toBeCloseTo(0.42);
        expect({ item, exposure }).toEqual(snapshot);
        expect(rank([item], [exposure])).toEqual(result);
        expect(rank([item], [])[0].score).toBe(1);
    });

    it("applies album recency when the exploration quota scores replacement candidates", () => {
        const familiar = Array.from({ length: 4 }, (_, index) => ({
            ...candidate(`known-${index}`, `Artist-${index}`, `Album-${index}`),
            providerPrior: 10,
            accountAffinity: 1,
            lane: "quickPicks" as const,
        }));
        const repeated = {
            ...candidate("repeat"),
            lane: "discovery" as const,
            providerPrior: 1.1,
        };
        const fresh = {
            ...candidate("fresh", "Other", "Fresh"),
            lane: "discovery" as const,
        };
        const result = rank([...familiar, repeated, fresh], [history()], {
            limit: 4,
            explorationRate: 0.25,
        });
        expect(result.map(({ track }) => track.id)).toContain("fresh");
        expect(result.map(({ track }) => track.id)).not.toContain("repeat");
    });
});
