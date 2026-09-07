import type { Client } from "pg";
import { prisma } from "../src/utils/db";
import { loadAccountHotSetCandidates } from "../src/services/recommendations/remoteAnalysisHotSet";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

jest.mock("../src/utils/redis", () => ({ redisClient: {} }));
jest.mock("../src/services/recommendations/onlineIdentityEnrichment", () => ({
    onlineIdentityEnricher: {},
}));

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    adminUrl && databaseName ? describe : describe.skip;

describeWithPostgres("remote analysis ready-work admission", () => {
    let admin: Client;
    const now = new Date();
    beforeAll(async () => {
        admin = await createScaleDatabase(adminUrl!, databaseName!);
        await applyScaleMigrations(process.env.DATABASE_URL!);
        await prisma.user.create({
            data: { id: "listener", username: "listener" },
        });
    });
    afterAll(async () => {
        await prisma.$disconnect();
        if (admin) await dropScaleDatabase(admin, databaseName!);
    });

    test("cooldown and in-flight rows cannot fill all16 slots ahead of ready music", async () => {
        for (let i = 0; i < 18; i++) {
            const id = `recording-${i}`;
            const blocked = i < 16;
            await prisma.canonicalRecording.create({
                data: {
                    id,
                    canonicalKey: id,
                    title: id,
                    artist: "artist",
                    duration: 180,
                    createdAt: new Date(
                        now.getTime() - (blocked ? 0 : 86400000),
                    ),
                    analysisStatus:
                        blocked && i % 2 === 0 ? "failed" : "pending",
                    mappings: {
                        create: {
                            confidence: 1,
                            source: "manual",
                            trackYtMusic: {
                                create: {
                                    videoId: id,
                                    title: id,
                                    artist: "artist",
                                    album: "album",
                                    duration: 180,
                                    likedBy: { create: { userId: "listener" } },
                                },
                            },
                        },
                    },
                    ...(blocked && i % 2 === 1
                        ? {
                              analysisLeases: {
                                  create: {
                                      provider: "youtube",
                                      providerTrackId: id,
                                      spoolRef: `.soundspan-analysis-spool/${id}.audio`,
                                      status: "processing",
                                      expiresAt: new Date(
                                          now.getTime() + 3600000,
                                      ),
                                  },
                              },
                          }
                        : {}),
                },
            });
        }
        const selected = await loadAccountHotSetCandidates("listener");
        expect(selected.map((row) => row.canonicalRecordingId).sort()).toEqual([
            "recording-16",
            "recording-17",
        ]);

        // The same failed recording becomes eligible again after the existing24h cooldown.
        await prisma.canonicalRecording.update({
            where: { id: "recording-0" },
            data: { updatedAt: new Date(now.getTime() - 25 * 3600000) },
        });
        expect(
            (await loadAccountHotSetCandidates("listener")).map(
                (row) => row.canonicalRecordingId,
            ),
        ).toContain("recording-0");
        expect(await prisma.analysisAssetLease.count()).toBe(8); // read-only selection

        await prisma.canonicalRecording.update({
            where: { id: "recording-17" },
            data: { embeddingStatus: "failed", embeddingAnalyzedAt: now },
        });
        expect(
            (await loadAccountHotSetCandidates("listener")).map(
                (row) => row.canonicalRecordingId,
            ),
        ).not.toContain("recording-17");
        await prisma.canonicalRecording.update({
            where: { id: "recording-17" },
            data: {
                embeddingAnalyzedAt: new Date(now.getTime() - 25 * 3600000),
            },
        });
        await prisma.analysisAssetLease.updateMany({
            where: { canonicalRecordingId: "recording-1" },
            data: { expiresAt: new Date(now.getTime() - 3600000) },
        });
        const retryable = (await loadAccountHotSetCandidates("listener")).map(
            (row) => row.canonicalRecordingId,
        );
        expect(retryable).toEqual(
            expect.arrayContaining(["recording-1", "recording-17"]),
        );
    });
});
