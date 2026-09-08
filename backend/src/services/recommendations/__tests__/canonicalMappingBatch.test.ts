const mockMappings = jest.fn();
const mockCanonical = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: {
        trackMapping: { findMany: mockMappings },
        canonicalRecording: { findUnique: mockCanonical },
    },
}));

import {
    findMappedCanonicalCandidates,
    providerTrackIdentityToCandidate,
} from "../canonicalIdentity";

const track = (id: string) =>
    providerTrackIdentityToCandidate({
        source: "youtube",
        providerTrackId: id,
        title: id,
        artist: "Artist",
    });
const row = (id: string, canonicalId = id) => ({
    trackYtMusic: { videoId: id },
    trackTidal: null,
    track: null,
    canonicalRecording: {
        id: canonicalId,
        canonicalKey: `key:${canonicalId}`,
        mergedIntoId: null,
        identitySource: null,
    },
});

describe("bounded canonical mapping batch", () => {
    beforeEach(() => {
        mockMappings.mockReset();
        mockCanonical.mockReset();
    });
    it("keeps candidate order and holes while reading known mappings once", async () => {
        mockMappings.mockResolvedValue([row("b"), row("a")]);
        await expect(
            findMappedCanonicalCandidates([
                track("a"),
                track("missing"),
                track("b"),
                track("a"),
            ]),
        ).resolves.toEqual([
            { id: "a", canonicalKey: "key:a" },
            null,
            { id: "b", canonicalKey: "key:b" },
            { id: "a", canonicalKey: "key:a" },
        ]);
        expect(mockMappings).toHaveBeenCalledTimes(1);
        expect(mockMappings.mock.calls[0][0].where.stale).toBe(false);
    });
    it("leaves ambiguous mappings to the ordinary resolver", async () => {
        mockMappings.mockResolvedValue([row("a"), row("a", "other")]);
        await expect(
            findMappedCanonicalCandidates([track("a")]),
        ).resolves.toEqual([null]);
    });
    it("resolves aliases but isolates a broken alias from healthy candidates", async () => {
        mockMappings.mockResolvedValue([
            row("a"),
            {
                ...row("b"),
                canonicalRecording: {
                    ...row("b").canonicalRecording,
                    mergedIntoId: "survivor",
                },
            },
            {
                ...row("c"),
                canonicalRecording: {
                    ...row("c").canonicalRecording,
                    identitySource: "identity-merged",
                },
            },
        ]);
        mockCanonical.mockResolvedValue({
            ...row("survivor").canonicalRecording,
        });
        await expect(
            findMappedCanonicalCandidates([track("a"), track("b"), track("c")]),
        ).resolves.toEqual([
            { id: "a", canonicalKey: "key:a" },
            { id: "survivor", canonicalKey: "key:survivor" },
            null,
        ]);
    });
    it("does no query for empty input and bounds each batch", async () => {
        await expect(findMappedCanonicalCandidates([])).resolves.toEqual([]);
        expect(mockMappings).not.toHaveBeenCalled();
        mockMappings.mockResolvedValue([]);
        const result = await findMappedCanonicalCandidates(
            Array.from({ length: 501 }, (_, i) => track(String(i))),
        );
        expect(result).toEqual(Array(501).fill(null));
        expect(mockMappings).toHaveBeenCalledTimes(3);
        for (const [query] of mockMappings.mock.calls)
            expect(query.take).toBeLessThanOrEqual(1000);
    });
});
