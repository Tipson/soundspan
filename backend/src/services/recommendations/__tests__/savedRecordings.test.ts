const mockFindMany = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: { canonicalRecording: { findMany: mockFindMany } },
}));
import { loadSavedCanonicalKeys } from "../savedRecordings";
import type { RecommendationCandidate } from "../types";

beforeEach(() => mockFindMany.mockReset());

it("does not query when candidates have no resolved originals", async () => {
    expect(await loadSavedCanonicalKeys("alice", [])).toEqual(new Set());
    expect(mockFindMany).not.toHaveBeenCalled();
});

it("bounds candidate reads and scopes liked originals to the requesting account", async () => {
    mockFindMany.mockResolvedValue([{ canonicalKey: "saved" }]);
    const candidates = Array.from(
        { length: 251 },
        (_, i) =>
            ({ canonicalRecordingId: `id-${i}` }) as RecommendationCandidate,
    );
    expect(await loadSavedCanonicalKeys("alice", candidates)).toEqual(
        new Set(["saved"]),
    );
    expect(mockFindMany).toHaveBeenCalledTimes(2);
    const queries = mockFindMany.mock.calls.map(([query]) => query);
    expect(queries.map((q) => q.where.id.in.length)).toEqual([250, 1]);
    for (const query of queries) {
        expect(query.take).toBeLessThanOrEqual(250);
        expect(query.where.mappings.some).toEqual({
            stale: false,
            trackYtMusic: { is: { likedBy: { some: { userId: "alice" } } } },
        });
    }
});

it("propagates lookup failures instead of treating missing knowledge as no saved tracks", async () => {
    mockFindMany.mockRejectedValue(new Error("DB unavailable"));
    await expect(
        loadSavedCanonicalKeys("alice", [
            { canonicalRecordingId: "id" } as RecommendationCandidate,
        ]),
    ).rejects.toThrow("DB unavailable");
});
