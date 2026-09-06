const mockCanonicalCount = jest.fn().mockResolvedValue(0);
const mockGenerationFindMany = jest.fn().mockResolvedValue([]);
const mockExposureCount = jest.fn().mockResolvedValue(0);
const mockExposureFindMany = jest.fn().mockResolvedValue([]);

jest.mock("../../../utils/db", () => ({
    prisma: {
        canonicalRecording: { count: mockCanonicalCount },
        recommendationGeneration: { findMany: mockGenerationFindMany },
        recommendationExposure: {
            count: mockExposureCount,
            findMany: mockExposureFindMany,
        },
    },
}));

import { recommendationShadowEvaluation } from "../shadowEvaluation";

test("keeps test accounts out of Hybrid engagement and participation counts", async () => {
    await recommendationShadowEvaluation.evaluate({
        since: new Date("2026-09-03T00:00:00Z"),
        until: new Date("2026-09-04T00:00:00Z"),
    });
    for (const query of [
        mockGenerationFindMany,
        mockExposureCount,
        mockExposureFindMany,
    ]) {
        expect(query).toHaveBeenLastCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    user: { isTestAccount: false },
                }),
            }),
        );
    }
});

test("excludes merge aliases from identity and analysis quality counters", async () => {
    await recommendationShadowEvaluation.evaluate({
        since: new Date("2026-09-03T00:00:00Z"),
        until: new Date("2026-09-04T00:00:00Z"),
    });

    expect(mockCanonicalCount).toHaveBeenCalledTimes(6);
    for (const [request] of mockCanonicalCount.mock.calls) {
        expect(request.where).toEqual(
            expect.objectContaining({
                mergedIntoId: null,
                NOT: { identitySource: "identity-merged" },
            }),
        );
    }
});
