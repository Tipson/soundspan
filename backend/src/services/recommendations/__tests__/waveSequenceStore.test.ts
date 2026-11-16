const mockFindFirst = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: { recommendationGeneration: { findFirst: mockFindFirst } },
}));
import { loadWaveSequenceGeneration } from "../waveSequenceStore";

describe("owned Wave continuation lookup", () => {
    beforeEach(() => mockFindFirst.mockReset());
    it("reads exactly one served Wave row with all ownership predicates", async () => {
        const row = {
            id: "g1",
            userId: "alice",
            sessionId: "tab",
            surface: "wave",
            served: true,
            createdAt: new Date(),
            context: { orderedWave: { version: 1 } },
        };
        mockFindFirst.mockResolvedValue(row);
        await expect(
            loadWaveSequenceGeneration("g1", "alice", "tab"),
        ).resolves.toBe(row);
        expect(mockFindFirst).toHaveBeenCalledTimes(1);
        expect(mockFindFirst).toHaveBeenCalledWith({
            where: {
                id: "g1",
                userId: "alice",
                sessionId: "tab",
                surface: "wave",
                served: true,
            },
            select: {
                id: true,
                userId: true,
                sessionId: true,
                surface: true,
                served: true,
                createdAt: true,
                context: true,
            },
        });
    });
    it("returns no row for missing or foreign generations", async () => {
        mockFindFirst.mockResolvedValue(null);
        await expect(
            loadWaveSequenceGeneration("foreign", "alice", "tab"),
        ).resolves.toBeNull();
    });
    it("does not disguise unavailable persistence as an expired sequence", async () => {
        mockFindFirst.mockRejectedValue(new Error("database unavailable"));
        await expect(
            loadWaveSequenceGeneration("g1", "alice", "tab"),
        ).rejects.toThrow("database unavailable");
    });
});
