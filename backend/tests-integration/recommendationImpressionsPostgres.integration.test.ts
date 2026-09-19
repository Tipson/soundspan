import { Client } from "pg";
import { prisma } from "../src/utils/db";
import { recommendationExposureStore } from "../src/services/recommendations/exposureStore";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const url = process.env.INTEGRATION_DATABASE_URL;
const name = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres = url && name ? describe : describe.skip;
const userId = "impression-test-owner";
const generationId = "impression-test-generation";
const tracks = Array.from({ length: 30 }, (_, index) => ({
    provider: "youtube",
    providerTrackId: `video-${index}`,
}));
const viewedAt = new Date("2026-09-01T12:00:00Z");

describeWithPostgres(
    "recommendation impressions PostgreSQL concurrency",
    () => {
        let admin: Client;
        let blocker: Client;

        beforeAll(async () => {
            admin = await createScaleDatabase(url!, name!);
            await applyScaleMigrations(process.env.DATABASE_URL!);
            blocker = new Client({
                connectionString: process.env.DATABASE_URL,
            });
            await blocker.connect();
            await prisma.user.create({
                data: { id: userId, username: "impression-test-owner" },
            });
            await prisma.recommendationGeneration.create({
                data: {
                    id: generationId,
                    userId,
                    sessionId: "session",
                    surface: "wave",
                    direction: "familiar",
                    algorithm: "test",
                    latencyMs: 1,
                    degradedSources: [],
                    exposures: {
                        create: tracks.map((track, position) => ({
                            ...track,
                            userId,
                            canonicalKey: `youtube:${track.providerTrackId}`,
                            artistKey: "artist",
                            source: "youtube",
                            position,
                        })),
                    },
                },
            });
        });

        beforeEach(async () => {
            await prisma.recommendationExposure.updateMany({
                where: { generationId },
                data: { viewedAt: null },
            });
        });

        afterAll(async () => {
            await prisma.$disconnect();
            await blocker?.end();
            if (admin && name) await dropScaleDatabase(admin, name);
        });

        it("serializes an impression batch behind another mutation of its generation", async () => {
            await blocker.query("BEGIN");
            await blocker.query(
                'SELECT "id" FROM "RecommendationGeneration" WHERE "id" = $1 FOR NO KEY UPDATE',
                [generationId],
            );
            let settled = false;
            const pending = recommendationExposureStore
                .markViewed({ userId, generationId, viewedAt, tracks })
                .finally(() => {
                    settled = true;
                });
            try {
                // Observe a real PostgreSQL waiter, not an assumed delay or SQL text.
                let waiting = false;
                for (let i = 0; i < 100 && !settled; i += 1) {
                    const result = await blocker.query<{ waiting: boolean }>(
                        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock') AS waiting",
                    );
                    if (result.rows[0]?.waiting) {
                        waiting = true;
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                expect(waiting).toBe(true);
                expect(settled).toBe(false);
            } finally {
                await blocker.query("ROLLBACK");
                await pending;
            }
            expect(
                await prisma.recommendationExposure.count({
                    where: { generationId, viewedAt },
                }),
            ).toBe(30);
        });

        it("records overlapping batches once without cross-account changes or overwritten timestamps", async () => {
            const updates = await Promise.all(
                Array.from({ length: 40 }, (_, index) =>
                    recommendationExposureStore.markViewed({
                        userId,
                        generationId,
                        viewedAt,
                        tracks: (index % 2
                            ? [...tracks].reverse()
                            : tracks
                        ).slice(index % 9),
                    }),
                ),
            );
            expect(updates.reduce((sum, value) => sum + value, 0)).toBe(30);
            expect(
                await recommendationExposureStore.markViewed({
                    userId: "other-user",
                    generationId,
                    viewedAt: new Date(),
                    tracks,
                }),
            ).toBe(0);
            expect(
                await recommendationExposureStore.markViewed({
                    userId,
                    generationId,
                    viewedAt: new Date(),
                    tracks,
                }),
            ).toBe(0);
            expect(
                await prisma.recommendationExposure.count({
                    where: { generationId, viewedAt },
                }),
            ).toBe(30);
        });
    },
);
