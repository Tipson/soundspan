import {
    CanonicalIdentityResolver,
    buildCanonicalRecordingKey,
} from "../canonicalIdentity";
import type { RecommendationCandidate } from "../types";

const track: RecommendationCandidate = {
    id: "yt:video-1",
    canonicalKey: "",
    title: "  One More Light (Remastered) ",
    duration: 243,
    artist: { id: null, name: "Linkin Park" },
    album: { id: null, title: "One More Light", coverArt: null },
    source: "youtube",
    provider: { tidalTrackId: null, youtubeVideoId: "video-1" },
    streamSource: "youtube",
    youtubeVideoId: "video-1",
    candidateSources: ["youtube-radio"],
    providerPrior: 1,
};

describe("canonical recording identity", () => {
    it("prefers durable identity and otherwise builds a stable metadata key", () => {
        expect(
            buildCanonicalRecordingKey({ ...track, recordingMbid: " MBID-1 " }),
        ).toBe("mbid:mbid-1");
        expect(
            buildCanonicalRecordingKey({ ...track, isrc: " gb-abc-12-34567 " }),
        ).toBe("isrc:GBABC1234567");
        expect(buildCanonicalRecordingKey(track)).toBe(
            "meta:linkin park:one more light:243",
        );
    });

    it("reuses one canonical row and attaches every provider mapping", async () => {
        const findProviderMapping = jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "canonical-1" });
        const findCanonical = jest.fn().mockResolvedValue(null);
        const upsertCanonical = jest.fn().mockResolvedValue({
            id: "canonical-1",
            canonicalKey: "meta:linkin park:one more light:243",
        });
        const attachProviderMapping = jest.fn().mockResolvedValue(undefined);
        const resolver = new CanonicalIdentityResolver({
            findProviderMapping,
            findCanonical,
            upsertCanonical,
            attachProviderMapping,
        });

        const first = await resolver.resolve(track);
        const second = await resolver.resolve(track);

        expect(first.id).toBe("canonical-1");
        expect(second.id).toBe("canonical-1");
        expect(upsertCanonical).toHaveBeenCalledTimes(1);
        expect(attachProviderMapping).toHaveBeenCalledTimes(1);
        expect(findProviderMapping).toHaveBeenNthCalledWith(
            1,
            "youtube",
            "video-1",
        );
    });
});
