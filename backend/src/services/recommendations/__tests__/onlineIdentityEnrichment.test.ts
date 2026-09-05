jest.mock("../../../utils/db", () => ({ prisma: {} }));
jest.mock("../../musicbrainz", () => ({ musicBrainzService: {} }));
jest.mock("../canonicalIdentity", () => ({
    ...jest.requireActual("../canonicalIdentity"),
    canonicalIdentityResolver: {},
}));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn() }) },
}));

import { OnlineIdentityEnricher } from "../onlineIdentityEnrichment";
import { persistOnlineIdentity } from "../onlineIdentityEnrichment";
import { prisma } from "../../../utils/db";
import { canonicalIdentityResolver } from "../canonicalIdentity";
import type { RecommendationCandidate } from "../types";

const youtubeCandidate = (id: string): RecommendationCandidate => ({
    id: `yt:${id}`,
    canonicalKey: `meta:artist:${id}:180`,
    canonicalRecordingId: `canonical-${id}`,
    title: id,
    duration: 180,
    artist: { id: null, name: "Artist" },
    album: { id: null, title: "Album", coverArt: null },
    source: "youtube",
    provider: { tidalTrackId: null, youtubeVideoId: id },
    streamSource: "youtube",
    candidateSources: ["youtube-radio"],
    providerPrior: 1,
});

describe("online canonical identity enrichment", () => {
    it("serializes durable identity merges and preserves analyzed features", async () => {
        const transaction = {
            $executeRaw: jest.fn().mockResolvedValue(1),
            canonicalRecording: {
                findFirst: jest.fn().mockImplementation(({ where }) =>
                    where.mergedIntoId
                        ? null
                        : {
                              id: "canonical-target",
                              canonicalKey: "mbid:target",
                              mergedIntoId: null,
                              identitySource: "musicbrainz-isrc",
                          },
                ),
                findMany: jest.fn().mockResolvedValue([]),
                findUnique: jest.fn().mockImplementation(({ select }) =>
                    select.mergedIntoId
                        ? {
                              id: "canonical-merge-source",
                              canonicalKey: "meta:artist:merge-source:180",
                              mergedIntoId: null,
                              identitySource: null,
                          }
                        : {
                              analysisStatus: "completed",
                              embeddingStatus: "completed",
                          },
                ),
                findUniqueOrThrow: jest.fn().mockResolvedValue({
                    recordingMbid: null,
                    isrc: null,
                    identitySource: null,
                    identityConfidence: 0,
                    identityVersion: 1,
                }),
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                update: jest.fn().mockResolvedValue({}),
            },
            trackMapping: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            recommendationExposure: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
        };
        const transactionRunner = jest.fn(
            async (callback: (client: typeof transaction) => Promise<string>) =>
                callback(transaction),
        );
        (
            prisma as unknown as { $transaction: typeof transactionRunner }
        ).$transaction = transactionRunner;
        const resolve = jest.fn().mockResolvedValue(undefined);
        (
            canonicalIdentityResolver as unknown as {
                resolve: typeof resolve;
            }
        ).resolve = resolve;

        const candidate = youtubeCandidate("merge-source");
        await persistOnlineIdentity(candidate, {
            tidalTrackId: 77,
            isrc: "USAAA2400001",
            recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
            confidence: 0.99,
        });

        const statements = transaction.$executeRaw.mock.calls.map(([parts]) =>
            (parts as TemplateStringsArray).join("?"),
        );
        expect(statements[0]).toContain("pg_advisory_xact_lock");
        expect(statements[1]).toContain(
            'UPDATE "CanonicalRecording" AS target',
        );
        expect(statements[2]).toContain(
            "INSERT INTO canonical_recording_embeddings",
        );
        expect(transaction.trackMapping.updateMany).toHaveBeenCalledWith({
            where: {
                canonicalRecordingId: candidate.canonicalRecordingId,
                stale: false,
            },
            data: { canonicalRecordingId: "canonical-target" },
        });
        expect(
            transaction.recommendationExposure.updateMany,
        ).toHaveBeenCalledWith({
            where: { canonicalRecordingId: candidate.canonicalRecordingId },
            data: {
                canonicalRecordingId: "canonical-target",
                canonicalKey: "mbid:target",
            },
        });
        expect(transaction.canonicalRecording.update).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                where: { id: candidate.canonicalRecordingId },
                data: expect.objectContaining({
                    identitySource: "identity-merged",
                }),
            }),
        );
        expect(transaction.canonicalRecording.update).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: { id: "canonical-target" },
                data: expect.objectContaining({
                    recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
                    identityLookupStatus: "completed",
                    identityLookupRetryCount: 0,
                    identityLookupError: null,
                    identityLookupUpdatedAt: expect.any(Date),
                }),
            }),
        );
        expect(resolve).toHaveBeenCalledWith(
            expect.objectContaining({
                canonicalRecordingId: "canonical-target",
                id: "tidal:77",
            }),
        );
    });

    it("defers a duplicate merge while analysis is writing the source row", async () => {
        const transaction = {
            $executeRaw: jest.fn().mockResolvedValue(1),
            canonicalRecording: {
                findFirst: jest.fn().mockImplementation(({ where }) =>
                    where.mergedIntoId
                        ? null
                        : {
                              id: "canonical-target",
                              canonicalKey: "mbid:target",
                              mergedIntoId: null,
                              identitySource: "musicbrainz-isrc",
                          },
                ),
                findMany: jest.fn().mockResolvedValue([]),
                findUnique: jest.fn().mockImplementation(({ select }) =>
                    select.mergedIntoId
                        ? {
                              id: "canonical-in-flight",
                              canonicalKey: "meta:artist:in-flight:180",
                              mergedIntoId: null,
                              identitySource: null,
                          }
                        : {
                              analysisStatus: "processing",
                              embeddingStatus: "pending",
                          },
                ),
                findUniqueOrThrow: jest.fn(),
                updateMany: jest.fn(),
                update: jest.fn(),
            },
            trackMapping: { updateMany: jest.fn() },
            recommendationExposure: { updateMany: jest.fn() },
        };
        (
            prisma as unknown as {
                $transaction: (
                    callback: (client: typeof transaction) => Promise<unknown>,
                ) => Promise<unknown>;
            }
        ).$transaction = async (callback) => callback(transaction);
        const resolve = jest.fn();
        (
            canonicalIdentityResolver as unknown as { resolve: typeof resolve }
        ).resolve = resolve;

        await persistOnlineIdentity(youtubeCandidate("in-flight"), {
            tidalTrackId: 77,
            isrc: "USAAA2400001",
            recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
            confidence: 0.99,
        });

        expect(transaction.trackMapping.updateMany).not.toHaveBeenCalled();
        expect(
            transaction.recommendationExposure.updateMany,
        ).not.toHaveBeenCalled();
        expect(transaction.canonicalRecording.update).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
    });

    it("defers a merge during the lease-before-processing transition", async () => {
        const transaction = {
            $executeRaw: jest.fn().mockResolvedValue(1),
            canonicalRecording: {
                findFirst: jest.fn().mockImplementation(({ where }) =>
                    where.mergedIntoId
                        ? null
                        : {
                              id: "canonical-target",
                              canonicalKey: "mbid:target",
                              mergedIntoId: null,
                              identitySource: "musicbrainz-isrc",
                          },
                ),
                findMany: jest.fn().mockResolvedValue([]),
                findUnique: jest
                    .fn()
                    .mockResolvedValueOnce({
                        id: "canonical-lease-transition",
                        canonicalKey: "meta:artist:lease-transition:180",
                        mergedIntoId: null,
                        identitySource: null,
                    })
                    .mockResolvedValueOnce({
                        analysisStatus: "pending",
                        embeddingStatus: "pending",
                        analysisLeases: [{ id: "active-lease" }],
                    })
                    .mockResolvedValueOnce({
                        analysisStatus: "pending",
                        embeddingStatus: "pending",
                        analysisLeases: [],
                    }),
                findUniqueOrThrow: jest.fn(),
                updateMany: jest.fn(),
                update: jest.fn(),
            },
            trackMapping: { updateMany: jest.fn() },
            recommendationExposure: { updateMany: jest.fn() },
        };
        (
            prisma as unknown as {
                $transaction: (
                    callback: (client: typeof transaction) => Promise<unknown>,
                ) => Promise<unknown>;
            }
        ).$transaction = async (callback) => callback(transaction);

        await persistOnlineIdentity(youtubeCandidate("lease-transition"), {
            tidalTrackId: null,
            isrc: "USAAA2400001",
            recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
            confidence: 0.99,
        });

        expect(transaction.trackMapping.updateMany).not.toHaveBeenCalled();
        expect(transaction.canonicalRecording.update).not.toHaveBeenCalled();
    });

    it("defers a duplicate merge while analysis is writing the survivor", async () => {
        const transaction = {
            $executeRaw: jest.fn().mockResolvedValue(1),
            canonicalRecording: {
                findFirst: jest.fn().mockImplementation(({ where }) =>
                    where.mergedIntoId
                        ? null
                        : {
                              id: "canonical-target",
                              canonicalKey: "mbid:target",
                              mergedIntoId: null,
                              identitySource: "musicbrainz-isrc",
                          },
                ),
                findMany: jest.fn().mockResolvedValue([]),
                findUnique: jest
                    .fn()
                    .mockResolvedValueOnce({
                        id: "canonical-survivor-writing",
                        canonicalKey: "meta:artist:survivor-writing:180",
                        mergedIntoId: null,
                        identitySource: null,
                    })
                    .mockResolvedValueOnce({
                        analysisStatus: "completed",
                        embeddingStatus: "completed",
                    })
                    .mockResolvedValueOnce({
                        analysisStatus: "processing",
                        embeddingStatus: "pending",
                    }),
                findUniqueOrThrow: jest.fn(),
                updateMany: jest.fn(),
                update: jest.fn(),
            },
            trackMapping: { updateMany: jest.fn() },
            recommendationExposure: { updateMany: jest.fn() },
        };
        (
            prisma as unknown as {
                $transaction: (
                    callback: (client: typeof transaction) => Promise<unknown>,
                ) => Promise<unknown>;
            }
        ).$transaction = async (callback) => callback(transaction);

        await persistOnlineIdentity(youtubeCandidate("survivor-writing"), {
            tidalTrackId: null,
            isrc: "USAAA2400001",
            recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
            confidence: 0.99,
        });

        expect(transaction.trackMapping.updateMany).not.toHaveBeenCalled();
        expect(transaction.canonicalRecording.update).not.toHaveBeenCalled();
    });

    it("does not overwrite durable identities or persist ambiguous matches", async () => {
        const persistIdentity = jest.fn();
        const lookupRecordingIdentityByMetadata = jest
            .fn()
            .mockResolvedValue(null);
        const enricher = new OnlineIdentityEnricher({
            lookupRecordingIdentityByMetadata,
            persistIdentity,
        });

        await enricher.enrich("alice", [
            { ...youtubeCandidate("known"), isrc: "USAAA2400001" },
            youtubeCandidate("missing"),
        ]);

        expect(lookupRecordingIdentityByMetadata).toHaveBeenCalledTimes(1);
        expect(lookupRecordingIdentityByMetadata).toHaveBeenCalledWith(
            expect.objectContaining({ title: "missing" }),
        );
        expect(persistIdentity).not.toHaveBeenCalled();
    });

    it("uses strict MusicBrainz metadata without requiring another provider", async () => {
        const persistIdentity = jest.fn().mockResolvedValue(undefined);
        const lookupRecordingIdentityByMetadata = jest.fn().mockResolvedValue({
            recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
            isrc: "USUM70824408",
            confidence: 0.96,
        });
        const enricher = new OnlineIdentityEnricher({
            lookupRecordingIdentityByMetadata,
            persistIdentity,
        });
        const candidate = youtubeCandidate("Poker Face");

        await enricher.enrich("alice", [candidate]);

        expect(lookupRecordingIdentityByMetadata).toHaveBeenCalledWith({
            title: "Poker Face",
            artist: "Artist",
            duration: 180,
        });
        expect(persistIdentity).toHaveBeenCalledWith(candidate, {
            tidalTrackId: null,
            isrc: "USUM70824408",
            recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
            confidence: 0.96,
            source: "musicbrainz-metadata",
        });
    });

    it("persists a metadata MBID without inventing a TIDAL mapping", async () => {
        const transaction = {
            $executeRaw: jest.fn().mockResolvedValue(1),
            canonicalRecording: {
                findFirst: jest.fn().mockResolvedValue(null),
                findMany: jest.fn().mockResolvedValue([]),
                findUnique: jest.fn().mockResolvedValue({
                    id: "canonical-metadata-only",
                    canonicalKey: "meta:artist:metadata-only:180",
                    mergedIntoId: null,
                    identitySource: null,
                }),
                findUniqueOrThrow: jest.fn().mockResolvedValue({
                    recordingMbid: null,
                    isrc: null,
                    identitySource: null,
                    identityConfidence: 0,
                    identityVersion: 1,
                }),
                updateMany: jest.fn(),
                update: jest.fn().mockResolvedValue({}),
            },
            trackMapping: { updateMany: jest.fn() },
            recommendationExposure: { updateMany: jest.fn() },
        };
        (
            prisma as unknown as {
                $transaction: (
                    callback: (client: typeof transaction) => Promise<string>,
                ) => Promise<string>;
            }
        ).$transaction = async (callback) => callback(transaction);
        const resolve = jest.fn();
        (
            canonicalIdentityResolver as unknown as { resolve: typeof resolve }
        ).resolve = resolve;

        await persistOnlineIdentity(youtubeCandidate("metadata-only"), {
            tidalTrackId: null,
            isrc: null,
            recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
            confidence: 0.94,
            source: "musicbrainz-metadata",
        });

        expect(transaction.canonicalRecording.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
                    identitySource: "musicbrainz-metadata",
                }),
            }),
        );
        expect(resolve).not.toHaveBeenCalled();
    });
});
