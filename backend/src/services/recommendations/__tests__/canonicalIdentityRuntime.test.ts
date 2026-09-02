const mockMappingFindFirst = jest.fn();
const mockMappingCreate = jest.fn();
const mockMappingUpdate = jest.fn();
const mockCanonicalFindFirst = jest.fn();
const mockCanonicalUpsert = jest.fn();
const mockYoutubeUpsert = jest.fn();
const mockTidalUpsert = jest.fn();

jest.mock("../../../utils/db", () => ({
    prisma: {
        trackMapping: {
            findFirst: mockMappingFindFirst,
            create: mockMappingCreate,
            update: mockMappingUpdate,
        },
        canonicalRecording: {
            findFirst: mockCanonicalFindFirst,
            upsert: mockCanonicalUpsert,
        },
        trackYtMusic: { upsert: mockYoutubeUpsert },
        trackTidal: { upsert: mockTidalUpsert },
    },
}));

import {
    buildCanonicalRecordingKey,
    canonicalIdentityResolver,
} from "../canonicalIdentity";
import type { RecommendationCandidate } from "../types";

function candidate(
    source: RecommendationCandidate["source"],
    overrides: Partial<RecommendationCandidate> = {},
): RecommendationCandidate {
    return {
        id: source === "library" ? "local-1" : `${source}:track-1`,
        canonicalKey: "",
        title: "Song (2024 Remastered Version)",
        duration: 181.6,
        artist: { id: null, name: "Artist" },
        album: { id: null, title: "Album", coverArt: "cover.jpg" },
        source,
        provider: {
            tidalTrackId: source === "tidal" ? 123 : null,
            youtubeVideoId: source === "youtube" ? "video-1" : null,
        },
        streamSource: source,
        youtubeVideoId: source === "youtube" ? "video-fallback" : undefined,
        tidalTrackId: source === "tidal" ? 456 : undefined,
        candidateSources: ["test"],
        providerPrior: 1,
        ...overrides,
    };
}

describe("default canonical identity persistence", () => {
    beforeEach(() => {
        mockMappingFindFirst.mockReset();
        mockMappingCreate.mockResolvedValue({ id: "mapping-new" });
        mockMappingUpdate.mockResolvedValue({ id: "mapping-existing" });
        mockCanonicalFindFirst.mockReset();
        mockCanonicalUpsert.mockResolvedValue({
            id: "canonical-new",
            canonicalKey: "meta:artist:song:183",
        });
        mockYoutubeUpsert.mockResolvedValue({ id: "youtube-row" });
        mockTidalUpsert.mockResolvedValue({ id: "tidal-row" });
    });

    it.each([
        [
            "youtube",
            "video-1",
            { trackYtMusic: { is: { videoId: "video-1" } } },
        ],
        ["tidal", "123", { trackTidal: { is: { tidalId: 123 } } }],
        ["library", "local-1", { track: { is: { id: "local-1" } } }],
    ] as const)(
        "reuses an existing %s provider mapping",
        async (source, _providerId, expectedWhere) => {
            mockMappingFindFirst.mockResolvedValue({
                canonicalRecording: {
                    id: "canonical-existing",
                    canonicalKey: "mbid:existing",
                },
            });

            await expect(
                canonicalIdentityResolver.resolve(candidate(source)),
            ).resolves.toEqual({
                id: "canonical-existing",
                canonicalKey: "mbid:existing",
            });
            expect(mockMappingFindFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining(expectedWhere),
                }),
            );
            expect(mockCanonicalFindFirst).not.toHaveBeenCalled();
        },
    );

    it("creates a canonical YouTube identity and a missing provider mapping", async () => {
        mockMappingFindFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        mockCanonicalFindFirst.mockResolvedValue(null);

        const result = await canonicalIdentityResolver.resolve(
            candidate("youtube", {
                provider: { tidalTrackId: null, youtubeVideoId: null },
                title: "Song [Deluxe Edition]",
                duration: -2,
            }),
        );

        expect(result.id).toBe("canonical-new");
        expect(mockCanonicalUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    canonicalKey: "meta:artist:song deluxe edition:0",
                    duration: 0,
                }),
            }),
        );
        expect(mockYoutubeUpsert).toHaveBeenCalledWith(
            expect.objectContaining({ where: { videoId: "video-fallback" } }),
        );
        expect(mockMappingCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                trackYtMusicId: "youtube-row",
                canonicalRecordingId: "canonical-new",
                confidence: 0.72,
            }),
        });
    });

    it("attaches an existing YouTube provider row to an existing canonical row", async () => {
        mockMappingFindFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "mapping-existing" });
        mockCanonicalFindFirst.mockResolvedValue({
            id: "canonical-existing",
            canonicalKey: "fingerprint:fp-1",
        });

        await canonicalIdentityResolver.resolve(
            candidate("youtube", { fingerprint: " FP-1 " }),
        );

        expect(mockMappingUpdate).toHaveBeenCalledWith({
            where: { id: "mapping-existing" },
            data: { canonicalRecordingId: "canonical-existing" },
        });
        expect(mockMappingCreate).not.toHaveBeenCalled();
    });

    it.each([
        [" GB-ABC-12-34567 ", 0.95],
        [undefined, 0.72],
    ])(
        "creates a Tidal mapping with identity confidence",
        async (isrc, confidence) => {
            mockMappingFindFirst
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null);
            mockCanonicalFindFirst.mockResolvedValue(null);

            await canonicalIdentityResolver.resolve(
                candidate("tidal", {
                    isrc,
                    provider: { tidalTrackId: null, youtubeVideoId: null },
                }),
            );

            expect(mockTidalUpsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { tidalId: 456 },
                    create: expect.objectContaining({
                        isrc: isrc ? " GB-ABC-12-34567 " : null,
                    }),
                }),
            );
            expect(mockMappingCreate).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    trackTidalId: "tidal-row",
                    confidence,
                }),
            });
        },
    );

    it("updates an existing Tidal mapping", async () => {
        mockMappingFindFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "mapping-existing" });
        mockCanonicalFindFirst.mockResolvedValue({
            id: "canonical-existing",
            canonicalKey: "meta:artist:song:183",
        });

        await canonicalIdentityResolver.resolve(candidate("tidal"));

        expect(mockMappingUpdate).toHaveBeenCalledWith({
            where: { id: "mapping-existing" },
            data: { canonicalRecordingId: "canonical-existing" },
        });
    });

    it("does not attach providers for an empty library id", async () => {
        mockCanonicalFindFirst.mockResolvedValue(null);

        await canonicalIdentityResolver.resolve(
            candidate("library", { id: "" }),
        );

        expect(mockMappingFindFirst).not.toHaveBeenCalled();
        expect(mockYoutubeUpsert).not.toHaveBeenCalled();
        expect(mockTidalUpsert).not.toHaveBeenCalled();
    });

    it("recovers the canonical row after a concurrent upsert race", async () => {
        mockMappingFindFirst.mockResolvedValue(null);
        mockCanonicalFindFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "canonical-raced",
                canonicalKey: "meta:artist:song:183",
            });
        mockCanonicalUpsert.mockRejectedValue(new Error("unique constraint"));

        await expect(
            canonicalIdentityResolver.resolve(candidate("library")),
        ).resolves.toEqual({
            id: "canonical-raced",
            canonicalKey: "meta:artist:song:183",
        });
    });

    it("rethrows an upsert failure when the raced row is still absent", async () => {
        mockMappingFindFirst.mockResolvedValue(null);
        mockCanonicalFindFirst.mockResolvedValue(null);
        const error = new Error("database unavailable");
        mockCanonicalUpsert.mockRejectedValue(error);

        await expect(
            canonicalIdentityResolver.resolve(candidate("library")),
        ).rejects.toBe(error);
    });

    it("normalizes durable and metadata identity variants", () => {
        expect(
            buildCanonicalRecordingKey(
                candidate("library", { fingerprint: " FingerPrint " }),
            ),
        ).toBe("fingerprint:fingerprint");
        expect(
            buildCanonicalRecordingKey(
                candidate("library", {
                    title: "  Song - 2024 Remastered  ",
                    artist: { id: null, name: "Artist’s  Name" },
                    duration: 184,
                }),
            ),
        ).toBe("meta:artist s name:song 2024 remastered:183");
        expect(
            buildCanonicalRecordingKey(
                candidate("library", { title: "Song (Live)", duration: -10 }),
            ),
        ).toBe("meta:artist:song live:0");
    });
});
