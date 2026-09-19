const mockProviderMappingFindFirst = jest.fn();
const mockProviderMappingCreate = jest.fn();
const mockProviderMappingUpdate = jest.fn();
const mockCanonicalFindFirst = jest.fn();
const mockCanonicalFindUnique = jest.fn();
const mockYoutubeUpsert = jest.fn();
const mockTransaction = jest.fn();

import { performance } from "node:perf_hooks";

jest.mock("../../../utils/db", () => ({
    prisma: {
        $transaction: mockTransaction,
        canonicalRecording: {
            findFirst: mockCanonicalFindFirst,
            findUnique: mockCanonicalFindUnique,
            upsert: jest.fn(),
        },
        trackMapping: {
            findFirst: mockProviderMappingFindFirst,
            create: mockProviderMappingCreate,
            update: mockProviderMappingUpdate,
        },
        trackYtMusic: { upsert: mockYoutubeUpsert },
        trackTidal: { upsert: jest.fn() },
    },
}));

import {
    canonicalIdentityResolver,
    resolveCanonicalSurvivor,
    runCanonicalIdentityTransaction,
} from "../canonicalIdentity";
import { persistCanonicalDurableIdentity } from "../durableIdentityPersistence";
import type { RecommendationCandidate } from "../types";

function youtubeCandidate(
    videoId: string,
    canonicalRecordingId?: string,
): RecommendationCandidate {
    return {
        id: `yt:${videoId}`,
        canonicalKey: "meta:artist:song:180",
        canonicalRecordingId,
        title: "Song",
        duration: 180,
        artist: { id: null, name: "Artist" },
        album: { id: null, title: "Album", coverArt: null },
        source: "youtube",
        provider: { tidalTrackId: null, youtubeVideoId: videoId },
        streamSource: "youtube",
        youtubeVideoId: videoId,
        candidateSources: ["test"],
        providerPrior: 1,
    };
}

describe("canonical identity merge aliases", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        mockProviderMappingCreate.mockResolvedValue({ id: "mapping-new" });
        mockProviderMappingUpdate.mockResolvedValue({ id: "mapping-existing" });
        mockYoutubeUpsert.mockResolvedValue({ id: "youtube-new" });
    });

    it("resolves the preserved metadata alias to the surviving canonical recording", async () => {
        let sourceWasMerged = false;
        const transaction = {
            $executeRaw: jest.fn().mockResolvedValue(1),
            canonicalRecording: {
                findFirst: jest.fn().mockImplementation(({ where }) =>
                    where.mergedIntoId
                        ? null
                        : {
                              id: "canonical-survivor",
                              canonicalKey:
                                  "mbid:b9991644-7275-44db-bc43-fff6c6b4ce69",
                              mergedIntoId: null,
                              identitySource: "musicbrainz-isrc",
                          },
                ),
                findMany: jest.fn().mockResolvedValue([
                    {
                        id: "canonical-survivor",
                        canonicalKey:
                            "mbid:b9991644-7275-44db-bc43-fff6c6b4ce69",
                        mergedIntoId: null,
                        identitySource: "musicbrainz-isrc",
                        recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
                        isrc: "USAAA2400001",
                    },
                ]),
                findUnique: jest
                    .fn()
                    .mockResolvedValueOnce({
                        id: "canonical-source",
                        canonicalKey: "meta:artist:song:180",
                        mergedIntoId: null,
                        identitySource: null,
                    })
                    .mockResolvedValue({
                        analysisStatus: "completed",
                        embeddingStatus: "completed",
                    }),
                findUniqueOrThrow: jest.fn().mockResolvedValue({
                    recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
                    isrc: "USAAA2400001",
                    identitySource: "musicbrainz-isrc",
                    identityConfidence: 0.99,
                    identityVersion: 1,
                }),
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                update: jest
                    .fn()
                    .mockImplementation(async ({ where, data }) => {
                        if (
                            where.id === "canonical-source" &&
                            data.identitySource === "identity-merged"
                        ) {
                            sourceWasMerged = true;
                        }
                        return {};
                    }),
            },
            trackMapping: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            recommendationExposure: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
        };
        mockTransaction.mockImplementation(async (load) => load(transaction));

        await persistCanonicalDurableIdentity(
            youtubeCandidate("video-old01", "canonical-source"),
            {
                tidalTrackId: null,
                isrc: "USAAA2400001",
                recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
                confidence: 0.99,
            },
        );
        expect(sourceWasMerged).toBe(true);

        mockTransaction.mockImplementation(async (load) =>
            load({
                canonicalRecording: {
                    findUnique: mockCanonicalFindUnique,
                },
                trackMapping: {
                    findFirst: mockProviderMappingFindFirst,
                    create: mockProviderMappingCreate,
                    update: mockProviderMappingUpdate,
                },
                trackYtMusic: { upsert: mockYoutubeUpsert },
                trackTidal: { upsert: jest.fn() },
            }),
        );

        mockProviderMappingFindFirst.mockResolvedValue(null);
        mockCanonicalFindFirst.mockResolvedValue({
            id: "canonical-source",
            canonicalKey: "meta:artist:song:180",
            mergedIntoId: sourceWasMerged ? "canonical-survivor" : null,
        });
        mockCanonicalFindUnique.mockResolvedValue({
            id: "canonical-survivor",
            canonicalKey: "mbid:b9991644-7275-44db-bc43-fff6c6b4ce69",
            mergedIntoId: null,
        });

        await expect(
            canonicalIdentityResolver.resolve(youtubeCandidate("video-new01")),
        ).resolves.toEqual({
            id: "canonical-survivor",
            canonicalKey: "mbid:b9991644-7275-44db-bc43-fff6c6b4ce69",
        });
        expect(mockProviderMappingCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                canonicalRecordingId: "canonical-survivor",
            }),
        });
    });

    it("fails closed for cyclic and unbounded alias chains", async () => {
        const cyclicDatabase = {
            canonicalRecording: {
                findUnique: jest.fn().mockImplementation(({ where: { id } }) =>
                    id === "canonical-b"
                        ? {
                              id: "canonical-b",
                              canonicalKey: "meta:b",
                              mergedIntoId: "canonical-a",
                              identitySource: "identity-merged",
                          }
                        : {
                              id: "canonical-a",
                              canonicalKey: "meta:a",
                              mergedIntoId: "canonical-b",
                              identitySource: "identity-merged",
                          },
                ),
            },
        };
        await expect(
            resolveCanonicalSurvivor(cyclicDatabase as never, {
                id: "canonical-a",
                canonicalKey: "meta:a",
                mergedIntoId: "canonical-b",
                identitySource: "identity-merged",
            }),
        ).rejects.toThrow("cycle");

        const deepDatabase = {
            canonicalRecording: {
                findUnique: jest
                    .fn()
                    .mockImplementation(({ where: { id } }) => ({
                        id,
                        canonicalKey: `meta:${id}`,
                        mergedIntoId: `${id}-next`,
                        identitySource: "identity-merged",
                    })),
            },
        };
        await expect(
            resolveCanonicalSurvivor(deepDatabase as never, {
                id: "canonical-0",
                canonicalKey: "meta:0",
                mergedIntoId: "canonical-1",
                identitySource: "identity-merged",
            }),
        ).rejects.toThrow("too deep");
    });

    it("retries a nested PostgreSQL serialization abort once", async () => {
        mockTransaction
            .mockRejectedValueOnce({
                meta: {
                    driverAdapterError: { cause: { code: "40001" } },
                },
            })
            .mockImplementationOnce(async (load) => load({}));
        const operation = jest.fn().mockResolvedValue("committed");

        await expect(runCanonicalIdentityTransaction(operation)).resolves.toBe(
            "committed",
        );
        expect(mockTransaction).toHaveBeenCalledTimes(2);
        expect(mockTransaction).toHaveBeenLastCalledWith(operation, {
            isolationLevel: "Serializable",
            maxWait: 2_000,
            timeout: 2_000,
        });
    });

    it("retries only the transient Prisma transaction-start timeout", async () => {
        const transactionStartTimeout = Object.assign(
            new Error(
                "Transaction API error: Unable to start a transaction in the given time.",
            ),
            { code: "P2028" },
        );
        mockTransaction
            .mockRejectedValueOnce(transactionStartTimeout)
            .mockImplementationOnce(async (load) => load({}));
        const operation = jest.fn().mockResolvedValue("committed");

        await expect(runCanonicalIdentityTransaction(operation)).resolves.toBe(
            "committed",
        );
        expect(mockTransaction).toHaveBeenCalledTimes(2);
    });

    it("survives a bounded burst of direct Prisma driver write conflicts", async () => {
        const serializationAbort = {
            name: "DriverAdapterError",
            cause: { kind: "TransactionWriteConflict" },
        };
        mockTransaction
            .mockRejectedValueOnce(serializationAbort)
            .mockRejectedValueOnce(serializationAbort)
            .mockRejectedValueOnce(serializationAbort)
            .mockRejectedValueOnce(serializationAbort)
            .mockRejectedValueOnce(serializationAbort)
            .mockImplementationOnce(async (load) => load({}));
        const operation = jest.fn().mockResolvedValue("committed");

        await expect(runCanonicalIdentityTransaction(operation)).resolves.toBe(
            "committed",
        );
        expect(mockTransaction).toHaveBeenCalledTimes(6);
    });

    it("stops retrying persistent Prisma driver write conflicts at the bound", async () => {
        const serializationAbort = {
            name: "DriverAdapterError",
            cause: { kind: "TransactionWriteConflict" },
        };
        mockTransaction.mockRejectedValue(serializationAbort);

        await expect(runCanonicalIdentityTransaction(jest.fn())).rejects.toBe(
            serializationAbort,
        );
        expect(mockTransaction).toHaveBeenCalledTimes(8);
    });

    it("does not start another transaction after the retry time budget expires", async () => {
        const serializationAbort = {
            name: "DriverAdapterError",
            cause: { kind: "TransactionWriteConflict" },
        };
        const now = jest
            .spyOn(performance, "now")
            .mockReturnValueOnce(1_000)
            .mockReturnValueOnce(1_000)
            .mockReturnValue(6_001);
        mockTransaction.mockRejectedValue(serializationAbort);

        try {
            await expect(
                runCanonicalIdentityTransaction(jest.fn()),
            ).rejects.toBe(serializationAbort);
            expect(mockTransaction).toHaveBeenCalledTimes(1);
        } finally {
            now.mockRestore();
        }
    });

    it("does not start the first transaction after its deadline has elapsed", async () => {
        const now = jest
            .spyOn(performance, "now")
            .mockReturnValueOnce(1_000)
            .mockReturnValue(6_001);

        try {
            await expect(
                runCanonicalIdentityTransaction(jest.fn()),
            ).rejects.toThrow("time budget expired");
            expect(mockTransaction).not.toHaveBeenCalled();
        } finally {
            now.mockRestore();
        }
    });

    it("shares the remaining deadline budget between transaction admission and execution", async () => {
        const serializationAbort = {
            name: "DriverAdapterError",
            cause: { kind: "TransactionWriteConflict" },
        };
        const now = jest
            .spyOn(performance, "now")
            .mockReturnValueOnce(1_000)
            .mockReturnValueOnce(1_000)
            .mockReturnValue(5_500);
        mockTransaction
            .mockRejectedValueOnce(serializationAbort)
            .mockResolvedValueOnce("committed");

        try {
            await expect(
                runCanonicalIdentityTransaction(jest.fn()),
            ).resolves.toBe("committed");
            expect(mockTransaction).toHaveBeenCalledTimes(2);
            const retryOptions = mockTransaction.mock.calls[1]?.[1] as {
                maxWait: number;
                timeout: number;
            };
            expect(retryOptions.maxWait).toBeGreaterThan(0);
            expect(retryOptions.timeout).toBeGreaterThan(0);
            expect(
                retryOptions.maxWait + retryOptions.timeout,
            ).toBeLessThanOrEqual(500);
        } finally {
            now.mockRestore();
        }
    });

    it("does not retry when the remaining budget cannot cover both transaction phases", async () => {
        const serializationAbort = {
            name: "DriverAdapterError",
            cause: { kind: "TransactionWriteConflict" },
        };
        const now = jest
            .spyOn(performance, "now")
            .mockReturnValueOnce(1_000)
            .mockReturnValueOnce(1_000)
            .mockReturnValue(5_999);
        mockTransaction
            .mockRejectedValueOnce(serializationAbort)
            .mockResolvedValueOnce("late commit");

        try {
            await expect(
                runCanonicalIdentityTransaction(jest.fn()),
            ).rejects.toBe(serializationAbort);
            expect(mockTransaction).toHaveBeenCalledTimes(1);
        } finally {
            now.mockRestore();
        }
    });

    it("does not retry when backoff consumes the minimum two-phase budget", async () => {
        const serializationAbort = {
            name: "DriverAdapterError",
            cause: { kind: "TransactionWriteConflict" },
        };
        const now = jest
            .spyOn(performance, "now")
            .mockReturnValueOnce(1_000)
            .mockReturnValueOnce(1_000)
            .mockReturnValueOnce(5_994)
            .mockReturnValue(5_999);
        const random = jest.spyOn(Math, "random").mockReturnValue(0);
        mockTransaction
            .mockRejectedValueOnce(serializationAbort)
            .mockResolvedValueOnce("late commit");

        try {
            await expect(
                runCanonicalIdentityTransaction(jest.fn()),
            ).rejects.toBe(serializationAbort);
            expect(mockTransaction).toHaveBeenCalledTimes(1);
        } finally {
            random.mockRestore();
            now.mockRestore();
        }
    });

    it("keeps retry accounting independent of wall-clock adjustments", async () => {
        const serializationAbort = {
            name: "DriverAdapterError",
            cause: { kind: "TransactionWriteConflict" },
        };
        const wallClock = jest
            .spyOn(Date, "now")
            .mockReturnValueOnce(1_000)
            .mockReturnValue(60_000);
        mockTransaction
            .mockRejectedValueOnce(serializationAbort)
            .mockResolvedValueOnce("committed");

        try {
            await expect(
                runCanonicalIdentityTransaction(jest.fn()),
            ).resolves.toBe("committed");
            expect(mockTransaction).toHaveBeenCalledTimes(2);
        } finally {
            wallClock.mockRestore();
        }
    });

    it("makes a repeated merge idempotent and does not re-copy analysis", async () => {
        const rows = new Map([
            [
                "canonical-source",
                {
                    id: "canonical-source",
                    canonicalKey: "meta:artist:song:180",
                    mergedIntoId: null as string | null,
                    identitySource: "metadata",
                },
            ],
            [
                "canonical-survivor",
                {
                    id: "canonical-survivor",
                    canonicalKey: "mbid:b9991644-7275-44db-bc43-fff6c6b4ce69",
                    mergedIntoId: null as string | null,
                    identitySource: "musicbrainz-isrc",
                },
            ],
        ]);
        const executeRaw = jest.fn().mockResolvedValue(1);
        const transaction = {
            $executeRaw: executeRaw,
            canonicalRecording: {
                findUnique: jest.fn().mockImplementation(({ where, select }) =>
                    select.analysisStatus
                        ? {
                              analysisStatus: "completed",
                              embeddingStatus: "completed",
                          }
                        : (rows.get(where.id) ?? null),
                ),
                findFirst: jest
                    .fn()
                    .mockImplementation(({ where }) =>
                        where.mergedIntoId
                            ? null
                            : where.id.not === "canonical-source"
                              ? rows.get("canonical-survivor")
                              : null,
                    ),
                findMany: jest
                    .fn()
                    .mockImplementation(({ where }) =>
                        where.id.not === "canonical-source"
                            ? [rows.get("canonical-survivor")]
                            : [],
                    ),
                findUniqueOrThrow: jest.fn().mockResolvedValue({
                    recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
                    isrc: "USAAA2400001",
                    identitySource: "musicbrainz-isrc",
                    identityConfidence: 0.99,
                    identityVersion: 1,
                }),
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                update: jest.fn().mockImplementation(({ where, data }) => {
                    const row = rows.get(where.id);
                    if (row && data.mergedIntoId) {
                        row.mergedIntoId = data.mergedIntoId;
                        row.identitySource = data.identitySource;
                    }
                    return {};
                }),
            },
            trackMapping: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            recommendationExposure: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
        };
        mockTransaction.mockImplementation(async (load) => load(transaction));
        const input = youtubeCandidate("video-old01", "canonical-source");
        const identity = {
            tidalTrackId: null,
            isrc: "USAAA2400001",
            recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
            confidence: 0.99,
        };

        await persistCanonicalDurableIdentity(input, identity);
        await persistCanonicalDurableIdentity(input, identity);

        const statements = executeRaw.mock.calls.map(([parts]) =>
            (parts as TemplateStringsArray).join("?"),
        );
        expect(
            statements.filter((statement) =>
                statement.includes('UPDATE "CanonicalRecording" AS target'),
            ),
        ).toHaveLength(1);
        expect(rows.get("canonical-source")?.mergedIntoId).toBe(
            "canonical-survivor",
        );
    });
});
