const mockFindMany = jest.fn();

jest.mock("../../../utils/db", () => ({
    prisma: {
        recommendationExposure: { findMany: mockFindMany },
    },
}));

import { recommendationExposureStore } from "../exposureStore";

describe("default recommendation exposure-store persistence", () => {
    beforeEach(() => {
        mockFindMany.mockReset();
    });

    it("loads the persisted artist identity with recent exposure signals", async () => {
        const viewedAt = new Date("2026-09-01T11:55:00.000Z");
        mockFindMany.mockResolvedValue([
            {
                canonicalKey: "mbid:previous-track",
                artistKey: "repeat artist",
                albumKey: '["repeat artist","album"]',
                viewedAt,
            },
        ]);

        await expect(
            recommendationExposureStore.loadRecent(
                "alice",
                new Date("2026-09-01T12:00:00.000Z"),
            ),
        ).resolves.toEqual([
            {
                canonicalKey: "mbid:previous-track",
                artistKey: "repeat artist",
                albumKey: '["repeat artist","album"]',
                exposedAt: viewedAt,
            },
        ]);
        expect(mockFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    userId: "alice",
                    viewedAt: { gte: new Date("2026-08-25T12:00:00.000Z") },
                    generation: { served: true },
                },
                select: {
                    canonicalKey: true,
                    artistKey: true,
                    albumKey: true,
                    viewedAt: true,
                },
            }),
        );
    });
});
