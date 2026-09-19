import { Client } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/utils/db";
import { createPlaybackTestAccount } from "../src/services/playbackTestAccount";
import { recommendationShadowEvaluation } from "../src/services/recommendations/shadowEvaluation";
import { recommendationExposureStore } from "../src/services/recommendations/exposureStore";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const integrationUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationUrl && databaseName ? describe : describe.skip;

describeWithPostgres("playback test isolation in PostgreSQL", () => {
    let admin: Client;
    beforeAll(async () => {
        admin = await createScaleDatabase(integrationUrl!, databaseName!);
        await applyScaleMigrations(process.env.DATABASE_URL!);
    });
    afterAll(async () => {
        await prisma.$disconnect();
        if (admin) await dropScaleDatabase(admin, databaseName!);
    });

    it("adds the flag to the prior User shape without changing existing account data", async () => {
        // This database is created and name-validated by the integration bootstrap.
        // Removing only the added column reconstructs the prior schema boundary.
        const connection = new Client({
            connectionString: process.env.DATABASE_URL,
        });
        await connection.connect();
        try {
            await connection.query("BEGIN");
            await connection.query(
                'ALTER TABLE "User" DROP COLUMN "isTestAccount"',
            );
            await connection.query(
                'INSERT INTO "User" (id, username, "passwordHash", "tokenVersion") VALUES ($1,$2,$3,$4)',
                ["prior-account", "prior-family", "unchanged-hash", 7],
            );
            await connection.query(
                await readFile(
                    path.join(
                        __dirname,
                        "../prisma/migrations/20260906060000_isolate_playback_test_accounts/migration.sql",
                    ),
                    "utf8",
                ),
            );
            await connection.query("COMMIT");
        } finally {
            await connection.end();
        }
        expect(
            await prisma.user.findUniqueOrThrow({
                where: { id: "prior-account" },
                select: {
                    username: true,
                    passwordHash: true,
                    tokenVersion: true,
                    isTestAccount: true,
                },
            }),
        ).toEqual({
            username: "prior-family",
            passwordHash: "unchanged-hash",
            tokenVersion: 7,
            isTestAccount: false,
        });
    });

    it("retains test evidence but excludes it from Hybrid and other accounts' repeat history", async () => {
        const ordinary = await prisma.user.create({
            data: { username: "family-listener" },
        });
        const fixture = await createPlaybackTestAccount(
            {
                username: "soundspan-test-isolation",
                password: "isolated-long-password",
            },
            {
                hashPassword: async () => "not-an-authentication-test",
                create: (data) => prisma.user.create({ data }),
            },
        );
        expect(ordinary.isTestAccount).toBe(false);
        expect(
            (await prisma.user.findUniqueOrThrow({ where: { id: fixture.id } }))
                .isTestAccount,
        ).toBe(true);
        const now = new Date();
        for (const userId of [ordinary.id, fixture.id]) {
            const isTest = userId === fixture.id;
            await prisma.recommendationGeneration.create({
                data: {
                    userId,
                    sessionId: "isolated-wave",
                    surface: "wave",
                    direction: "for-you",
                    algorithm: "baseline-v1",
                    served: true,
                    latencyMs: isTest ? 9000 : 100,
                    degradedSources: [],
                    createdAt: now,
                    exposures: {
                        create: Array.from(
                            { length: isTest ? 100 : 1 },
                            (_, index) => ({
                                userId,
                                canonicalKey: `${isTest ? "test" : "real"}-${index}`,
                                artistKey: isTest
                                    ? "fixture-artist"
                                    : "real-artist",
                                provider: "youtube",
                                providerTrackId: `${isTest ? "test" : "real"}-${index}`,
                                source: "youtube",
                                position: index,
                                exposedAt: now,
                                viewedAt: now,
                                playedAt: now,
                                listenedSeconds: isTest ? 3 : 180,
                                completionRatio: isTest ? 0.01 : 1,
                                outcome: isTest ? "skipped" : "completed",
                            }),
                        ),
                    },
                },
            });
        }
        const report = await recommendationShadowEvaluation.evaluate({
            since: new Date(now.getTime() - 1000),
            until: new Date(now.getTime() + 1000),
        });
        expect(report.algorithms.baseline.generationCount).toBe(1);
        expect(report.algorithms.baseline.latency.meanMs).toBe(100);
        expect(report.algorithms.baseline.engagement?.completionRate).toBe(1);
        expect(report.algorithms.baseline.playability?.earlySkipCount).toBe(0);
        expect(report.dataQuality?.experiment).toEqual({
            viewedImpressionCount: 1,
            participatingAccountCount: 1,
        });
        expect(
            await prisma.recommendationExposure.count({
                where: { userId: fixture.id },
            }),
        ).toBe(100);
        const history = await recommendationExposureStore.loadRecent(
            ordinary.id,
            new Date(now.getTime() + 1000),
        );
        expect(history.map((row) => row.canonicalKey)).toEqual(["real-0"]);

        await expect(
            createPlaybackTestAccount(
                {
                    username: ordinary.username,
                    password: "replacement-password",
                },
                {
                    hashPassword: async () => "replacement",
                    create: (data) => prisma.user.create({ data }),
                },
            ),
        ).rejects.toThrow();
        expect(
            await prisma.user.findUniqueOrThrow({ where: { id: ordinary.id } }),
        ).toEqual(ordinary);
    });
});
