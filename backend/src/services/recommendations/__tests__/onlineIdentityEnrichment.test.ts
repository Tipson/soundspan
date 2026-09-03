jest.mock("../../../utils/db", () => ({ prisma: {} }));
jest.mock("../../musicbrainz", () => ({ musicBrainzService: {} }));
jest.mock("../../tidalStreaming", () => ({ tidalStreamingService: {} }));
jest.mock("../canonicalIdentity", () => ({ canonicalIdentityResolver: {} }));
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
    it("resolves an existing TIDAL ISRC without searching TIDAL again", async () => {
        const persistIdentity = jest.fn().mockResolvedValue(undefined);
        const findMatches = jest.fn();
        const lookupRecordingMbidByIsrc = jest
            .fn()
            .mockResolvedValue("b9991644-7275-44db-bc43-fff6c6b4ce69");
        const enricher = new OnlineIdentityEnricher({
            findMatches,
            lookupRecordingMbidByIsrc,
            lookupRecordingIdentityByMetadata: jest.fn(),
            persistIdentity,
        });
        const tidalCandidate: RecommendationCandidate = {
            ...youtubeCandidate("tidal-known-isrc"),
            id: "tidal:77",
            source: "tidal",
            streamSource: "tidal",
            isrc: "US-AAA-24-00001",
            provider: { tidalTrackId: 77, youtubeVideoId: null },
            tidalTrackId: 77,
        };

        await enricher.enrich("alice", [tidalCandidate]);

        expect(findMatches).not.toHaveBeenCalled();
        expect(lookupRecordingMbidByIsrc).toHaveBeenCalledWith("USAAA2400001");
        expect(persistIdentity).toHaveBeenCalledWith(tidalCandidate, {
            tidalTrackId: 77,
            isrc: "USAAA2400001",
            recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
            confidence: 0.99,
            source: "musicbrainz-isrc",
        });
    });

    it("serializes durable identity merges and preserves analyzed features", async () => {
        const transaction = {
            $executeRaw: jest.fn().mockResolvedValue(1),
            canonicalRecording: {
                findFirst: jest
                    .fn()
                    .mockResolvedValue({ id: "canonical-target" }),
                findUnique: jest.fn().mockResolvedValue({
                    analysisStatus: "completed",
                    embeddingStatus: "completed",
                }),
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
            data: { canonicalRecordingId: "canonical-target" },
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
                findFirst: jest
                    .fn()
                    .mockResolvedValue({ id: "canonical-target" }),
                findUnique: jest.fn().mockResolvedValue({
                    analysisStatus: "processing",
                    embeddingStatus: "pending",
                }),
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

    it("persists TIDAL ISRC and unambiguous MusicBrainz recording identity", async () => {
        const persistIdentity = jest.fn().mockResolvedValue(undefined);
        const enricher = new OnlineIdentityEnricher({
            findMatches: jest.fn().mockResolvedValue([
                {
                    id: 42,
                    title: "one",
                    artist: "Artist",
                    duration: 180,
                    isrc: "GB-ABC-12-34567",
                },
            ]),
            lookupRecordingMbidByIsrc: jest
                .fn()
                .mockResolvedValue("b9991644-7275-44db-bc43-fff6c6b4ce69"),
            lookupRecordingIdentityByMetadata: jest.fn(),
            persistIdentity,
        });

        await enricher.enrich("alice", [youtubeCandidate("one")]);

        expect(persistIdentity).toHaveBeenCalledWith(
            youtubeCandidate("one"),
            expect.objectContaining({
                tidalTrackId: 42,
                isrc: "GBABC1234567",
                recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
                confidence: 0.99,
            }),
        );
    });

    it("does not overwrite durable identities or persist ambiguous matches", async () => {
        const findMatches = jest.fn().mockResolvedValue([null]);
        const persistIdentity = jest.fn();
        const enricher = new OnlineIdentityEnricher({
            findMatches,
            lookupRecordingMbidByIsrc: jest.fn(),
            lookupRecordingIdentityByMetadata: jest
                .fn()
                .mockResolvedValue(null),
            persistIdentity,
        });

        await enricher.enrich("alice", [
            { ...youtubeCandidate("known"), isrc: "USAAA2400001" },
            youtubeCandidate("missing"),
        ]);

        expect(findMatches).toHaveBeenCalledWith("alice", [
            expect.objectContaining({ title: "missing" }),
        ]);
        expect(persistIdentity).not.toHaveBeenCalled();
    });

    it("falls back to strict MusicBrainz metadata when TIDAL is unavailable", async () => {
        const persistIdentity = jest.fn().mockResolvedValue(undefined);
        const lookupRecordingIdentityByMetadata = jest.fn().mockResolvedValue({
            recordingMbid: "b9991644-7275-44db-bc43-fff6c6b4ce69",
            isrc: "USUM70824408",
            confidence: 0.96,
        });
        const enricher = new OnlineIdentityEnricher({
            findMatches: jest
                .fn()
                .mockRejectedValue(new Error("no TIDAL auth")),
            lookupRecordingMbidByIsrc: jest.fn(),
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
                findUnique: jest.fn(),
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
