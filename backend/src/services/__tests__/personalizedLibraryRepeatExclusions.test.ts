const mockFindMany = jest.fn();
jest.mock("../../utils/db", () => ({
    prisma: { play: { findMany: mockFindMany } },
}));
import { loadLibraryRepeatExclusions } from "../personalizedTrackPreferences";

const now = new Date("2026-10-08T00:20:00Z");
const row = (
    id: string,
    ageHours: number,
    listenedSeconds = 0,
    outcome: string | null = null,
) => ({
    playedAt: new Date(now.getTime() - ageHours * 3_600_000),
    listenedSeconds,
    outcome,
    track: { id, title: id, album: { artist: { name: "Local artist" } } },
});

describe("local actual-listening policy for automatic radio continuation", () => {
    it("reuses strict24h/7d, >=30s and failed-neutral rules under the requested owner and clock", async () => {
        mockFindMany.mockResolvedValue([
            row("recent", 1),
            row("heard", 48, 30),
            row("short", 48, 29),
            row("failed", 1, 99, "failed"),
            row("exact24h", 24),
            row("exact7d", 168, 90),
            row("future", -1, 99),
            { ...row("deleted", 1), track: null },
        ]);
        const result = await loadLibraryRepeatExclusions("alice", now);
        expect([...result.videoIds]).toEqual([
            "library:recent",
            "library:heard",
        ]);
        expect([...result.hardVideoIds]).toEqual(["library:recent"]);
        expect(result.songKeys.size).toBe(2);
        expect(mockFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    userId: "alice",
                    trackId: { not: null },
                    playedAt: {
                        gte: new Date(now.getTime() - 7 * 86_400_000),
                        lte: now,
                    },
                },
                take: 1_000,
                orderBy: [{ playedAt: "desc" }, { id: "asc" }],
            }),
        );
    });
});
