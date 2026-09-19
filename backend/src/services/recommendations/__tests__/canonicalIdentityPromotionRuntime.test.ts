const mockFindNextIntent = jest.fn();
const mockRecoverIntent = jest.fn();
const mockTransactionIntentUpdateMany = jest.fn();
const mockSourceFindUnique = jest.fn();
const mockCanonicalUpdateMany = jest.fn();
const mockPersistIdentity = jest.fn();
const mockRunTransaction = jest.fn();

jest.mock("../../../utils/db", () => ({
    prisma: {
        canonicalIdentityPromotionIntent: {
            findFirst: (...args: unknown[]) => mockFindNextIntent(...args),
            updateMany: (...args: unknown[]) => mockRecoverIntent(...args),
        },
    },
}));
jest.mock("../canonicalIdentity", () => ({
    runCanonicalIdentityTransaction: (...args: unknown[]) =>
        mockRunTransaction(...args),
}));
jest.mock("../durableIdentityPersistence", () => ({
    persistCanonicalDurableIdentityInTransaction: (...args: unknown[]) =>
        mockPersistIdentity(...args),
}));

import { processNextCanonicalIdentityPromotion } from "../canonicalIdentityPromotion";

describe("canonical identity promotion retry isolation", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFindNextIntent.mockResolvedValue({
            id: "poison-intent",
            attemptCount: 0,
            failureCount: 0,
            sourceCanonicalId: "canonical-source",
            expectedFingerprint: "fingerprint",
            recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
            confidence: 0.99,
        });
        mockRecoverIntent.mockResolvedValue({ count: 1 });
        mockTransactionIntentUpdateMany.mockResolvedValue({ count: 1 });
        mockSourceFindUnique.mockResolvedValue({
            id: "canonical-source",
            canonicalKey: "meta:artist:song:180",
            fingerprint: "fingerprint",
            title: "Song",
            artist: "Artist",
            duration: 180,
        });
        mockCanonicalUpdateMany.mockResolvedValue({ count: 1 });
        mockPersistIdentity.mockRejectedValue(
            new Error("deterministic settlement failure"),
        );
        mockRunTransaction.mockImplementation(async (operation) =>
            operation({
                canonicalIdentityPromotionIntent: {
                    findFirst: mockFindNextIntent,
                    updateMany: mockTransactionIntentUpdateMany,
                },
                canonicalRecording: {
                    findUnique: mockSourceFindUnique,
                    updateMany: mockCanonicalUpdateMany,
                },
            }),
        );
    });

    it("moves a failed intent out of the ready head so later intents can proceed", async () => {
        await expect(processNextCanonicalIdentityPromotion()).resolves.toBe(
            "deferred",
        );

        expect(mockRecoverIntent).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    id: "poison-intent",
                    status: "pending",
                    attemptCount: 0,
                    failureCount: 0,
                },
                data: expect.objectContaining({
                    attemptCount: { increment: 1 },
                    failureCount: { increment: 1 },
                    availableAt: expect.any(Date),
                    lastError: "Error",
                }),
            }),
        );
    });

    it("bounds poison retries and atomically releases the source for re-lookup", async () => {
        mockFindNextIntent.mockResolvedValue({
            id: "poison-intent",
            attemptCount: 7,
            failureCount: 7,
            sourceCanonicalId: "canonical-source",
            expectedFingerprint: "fingerprint",
            recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
            confidence: 0.99,
        });

        await expect(processNextCanonicalIdentityPromotion()).resolves.toBe(
            "failed",
        );

        expect(mockTransactionIntentUpdateMany).toHaveBeenLastCalledWith({
            where: {
                id: "poison-intent",
                status: "pending",
                attemptCount: 7,
                failureCount: 7,
            },
            data: expect.objectContaining({
                status: "failed",
                expectedFingerprint: "",
                attemptCount: { increment: 1 },
                failureCount: { increment: 1 },
                lastError: "Error",
            }),
        });
        expect(mockCanonicalUpdateMany).toHaveBeenCalledWith({
            where: {
                id: "canonical-source",
                fingerprint: "fingerprint",
                identityLookupStatus: "merge_pending",
                recordingMbid: null,
                mergedIntoId: null,
            },
            data: expect.objectContaining({
                identityLookupStatus: "failed",
            }),
        });
    });
});
