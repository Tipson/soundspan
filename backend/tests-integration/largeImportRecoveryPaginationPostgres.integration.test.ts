import express from "express";
import request, { type Response } from "supertest";
import type { Client } from "pg";
import { prisma } from "../src/utils/db";
import { backgroundPlaylistImport } from "../src/services/backgroundPlaylistImport";
import { GenericImportJobRunner } from "../src/services/genericImportJobRunner";
import { importJobStore } from "../src/services/importJobStore";
import {
    playlistImportService,
    type ResolvedTrack,
} from "../src/services/playlistImportService";
import { ytMusicService } from "../src/services/youtubeMusic";
import playlistsRouter from "../src/routes/playlists";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

// External providers and post-match enrichment are outside this offline scenario.
// The runner, job store, playlist persistence, pagination and PostgreSQL are real.
jest.mock("../src/services/spotify", () => ({ spotifyService: {} }));
jest.mock("../src/services/deezer", () => ({ deezerService: {} }));
jest.mock("../src/services/youtubeMusic", () => ({
    ytMusicService: { findMatchesForAlbum: jest.fn() },
}));
jest.mock("../src/workers/queues", () => ({
    genericImportQueue: { getJob: jest.fn(async () => null), add: jest.fn() },
}));
jest.mock("../src/services/coalescedLibraryScan", () => ({
    requestCoalescedLibraryScan: jest.fn(),
}));
jest.mock("../src/services/recommendations/canonicalIdentity", () => ({
    canonicalIdentityResolver: { resolveProviderTrack: jest.fn() },
}));
jest.mock("../src/services/recommendations/durableIdentityPersistence", () => ({
    persistImportedProviderIdentity: jest.fn(),
}));
jest.mock("../src/services/trackMappingService", () => ({
    trackMappingService: {
        createMapping: jest.fn(async () => undefined),
        upsertTrackYtMusic: jest.fn(
            async (track: {
                videoId: string;
                title: string;
                artist: string;
                album: string;
                duration: number;
            }) => {
                const { prisma: database } =
                    jest.requireActual<typeof import("../src/utils/db")>(
                        "../src/utils/db",
                    );
                return database.trackYtMusic.upsert({
                    where: { videoId: track.videoId },
                    create: track,
                    update: {},
                });
            },
        ),
    },
}));
jest.mock("../src/middleware/auth", () => ({
    requireAuthOrToken: (
        _req: express.Request,
        _res: express.Response,
        next: express.NextFunction,
    ) => next(),
    requireAdmin: (
        _req: express.Request,
        _res: express.Response,
        next: express.NextFunction,
    ) => next(),
}));

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;
const TOTAL = 1294;
const USER = "large-import-recovery-owner";
const JOB = "large-import-recovery-job";

function summary(ready: number) {
    return {
        total: TOTAL,
        local: 0,
        youtube: ready,
        tidal: 0,
        unresolved: TOTAL - ready,
    };
}

describeWithPostgres(
    "large import recovery and cursor pagination in PostgreSQL",
    () => {
        let admin: Client;
        const app = express();
        app.use((req, _res, next) => {
            req.user = { id: USER, username: USER, role: "user" };
            next();
        });
        app.use("/playlists", playlistsRouter);

        beforeAll(async () => {
            admin = await createScaleDatabase(
                integrationDatabaseUrl!,
                databaseName!,
            );
            await applyScaleMigrations(process.env.DATABASE_URL!);
        });
        afterAll(async () => {
            jest.restoreAllMocks();
            await prisma.$disconnect();
            if (admin) await dropScaleDatabase(admin, databaseName!);
        });

        async function readEveryPosition(playlistId: string, ready: number) {
            const positions: number[] = [];
            const ids = new Set<string>();
            let cursor: string | null = null;
            let pages = 0;
            do {
                const response: Response = await request(app)
                    .get(`/playlists/${playlistId}`)
                    .query({ limit: 137, ...(cursor ? { cursor } : {}) })
                    .expect(200);
                expect(response.body.totalItemCount).toBe(TOTAL);
                expect(response.body.trackCount).toBe(ready);
                expect(response.body.pendingCount).toBe(TOTAL - ready);
                expect(response.body.mergedItems.length).toBeLessThanOrEqual(
                    137,
                );
                for (const item of response.body.mergedItems as Array<{
                    id: string;
                    sort: number;
                    type: string;
                    playback: { isPlayable: boolean };
                }>) {
                    expect(ids.has(item.id)).toBe(false);
                    ids.add(item.id);
                    positions.push(item.sort);
                    expect(item.playback.isPlayable).toBe(
                        item.type !== "pending",
                    );
                }
                cursor = response.body.pagination.nextCursor;
                expect(response.body.pagination.hasMore).toBe(cursor !== null);
                pages += 1;
                expect(pages).toBeLessThanOrEqual(10);
            } while (cursor);
            expect(positions).toEqual(
                Array.from({ length: TOTAL }, (_, index) => index),
            );
            expect(pages).toBe(10);
        }

        it("keeps 1294 ordered occurrences through failure, a fresh runner, retry and ten cursor pages", async () => {
            await prisma.user.create({ data: { id: USER, username: USER } });
            await prisma.importJob.create({
                data: {
                    id: JOB,
                    userId: USER,
                    sourceType: "spotify",
                    sourceId: "offline-fixture",
                    sourceUrl: "https://soundspan.test/offline-fixture",
                    normalizedSource: "spotify:offline-fixture",
                    playlistName: "1294-position fixture",
                    status: "resolving",
                    summary: summary(0),
                },
            });
            const tracks: ResolvedTrack[] = Array.from(
                { length: TOTAL },
                (_, index) => ({
                    index,
                    artist: "Fixture Artist",
                    title: `Fixture ${index % 2}`,
                    album: "Fixture Album",
                    duration: 180,
                    source: "unresolved",
                    confidence: 0,
                }),
            );
            const initialized = await backgroundPlaylistImport.initialize({
                jobId: JOB,
                userId: USER,
                playlistName: "1294-position fixture",
                tracks,
            });
            await readEveryPosition(initialized.playlistId, 0);
            const providers = await Promise.all(
                [0, 1].map((index) =>
                    prisma.trackYtMusic.create({
                        data: {
                            videoId: `fixture-${index}`,
                            title: `Fixture ${index}`,
                            artist: "Fixture Artist",
                            album: "Fixture Album",
                            duration: 180,
                        },
                    }),
                ),
            );
            const firstBatch: ResolvedTrack[] = tracks
                .slice(0, 250)
                .map((track) => ({
                    ...track,
                    source: "youtube",
                    confidence: 100,
                    trackYtMusicId: providers[track.index % 2].id,
                    videoId: providers[track.index % 2].videoId,
                }));
            const snapshot = [...firstBatch, ...tracks.slice(250)];
            const checkpoint = {
                jobId: JOB,
                userId: USER,
                playlistId: initialized.playlistId,
                expectedResolutionAttempt: initialized.resolutionAttempt,
                newlyResolved: firstBatch,
                snapshot,
                summary: summary(250),
                progress: 40,
                resolutionProcessed: 250,
            };
            expect(
                await backgroundPlaylistImport.persistResolution(checkpoint),
            ).toBe(true);
            expect(
                await backgroundPlaylistImport.persistResolution(checkpoint),
            ).toBe(true);
            await new GenericImportJobRunner().finalizeQueueFailure(
                JOB,
                new Error("fixture queue lease exhausted"),
            );
            expect(await importJobStore.getJob(JOB)).toMatchObject({
                status: "failed",
                summary: summary(250),
                error: "Generic import job failed",
            });
            await readEveryPosition(initialized.playlistId, 250);

            // Close the database connection and replace the runner. The only resume
            // state is the persisted job; this does not claim an OS process restart.
            await prisma.$disconnect();
            const retry = await importJobStore.requestResolutionRetry(
                JOB,
                USER,
            );
            expect(retry.outcome).toBe("updated");
            expect(retry.job).toMatchObject({
                status: "resolving",
                resolutionAttempt: 2,
                error: null,
            });
            const providerMatch = jest.mocked(
                ytMusicService.findMatchesForAlbum,
            );
            let matchedPositions = 0;
            let failedBatch = false;
            providerMatch.mockImplementation(async (_user, batch) => {
                matchedPositions += batch.length;
                if (!failedBatch) {
                    failedBatch = true;
                    throw new Error("fixture upstream unavailable");
                }
                return batch.map((track) => ({
                    videoId: `fixture-${track.title.endsWith("0") ? 0 : 1}`,
                    title: track.title,
                    artist: "Fixture Artist",
                    duration: 180,
                }));
            });
            const fetchSource = jest.spyOn(
                playlistImportService,
                "fetchSourceTracks",
            );
            await new GenericImportJobRunner().runJob(JOB, {
                retryFailures: true,
                finalAttempt: false,
            });
            expect(fetchSource).not.toHaveBeenCalled();
            expect(matchedPositions).toBe(TOTAL - 250);
            expect(await importJobStore.getJob(JOB)).toMatchObject({
                status: "completed",
                summary: summary(TOTAL - 25),
                error: null,
            });
            await readEveryPosition(initialized.playlistId, TOTAL - 25);
            const callsBeforeReplay = providerMatch.mock.calls.length;
            await new GenericImportJobRunner().runJob(JOB);
            expect(providerMatch).toHaveBeenCalledTimes(callsBeforeReplay);

            const secondRetry = await importJobStore.requestResolutionRetry(
                JOB,
                USER,
            );
            expect(secondRetry.outcome).toBe("updated");
            matchedPositions = 0;
            await prisma.$disconnect();
            await new GenericImportJobRunner().runJob(JOB);
            expect(matchedPositions).toBe(25);
            expect(await importJobStore.getJob(JOB)).toMatchObject({
                status: "completed",
                summary: summary(TOTAL),
                resolutionAttempt: 3,
            });
            await readEveryPosition(initialized.playlistId, TOTAL);
            expect(
                await prisma.playlist.count({ where: { userId: USER } }),
            ).toBe(1);
            expect(
                await prisma.playlistItem.count({
                    where: { playlistId: initialized.playlistId },
                }),
            ).toBe(TOTAL);
            console.info(
                "verify: positions=1294 ordered=true cursorPages=10 checkpointReplay=true freshRunner=true failedJobRetried=true unresolvedBatchRetried=25 sourceRefetches=0 externalProviderRequests=0",
            );
        });
    },
);
