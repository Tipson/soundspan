import { Client } from "pg";

jest.mock("../src/services/recommendations/remoteAnalysisHotSet", () => ({
    remoteAnalysisHotSetScheduler: { schedule: jest.fn() },
}));
jest.mock("../src/utils/logger", () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        child: () => ({ info: mockCompleted, warn: mockFailed }),
    },
}));
const mockCompleted = jest.fn();
const mockFailed = jest.fn();

import { prisma } from "../src/utils/db";
import { remoteAnalysisHotSetScheduler } from "../src/services/recommendations/remoteAnalysisHotSet";
import {
    startRemoteAnalysisHotSetSweep,
    stopRemoteAnalysisHotSetSweep,
} from "../src/services/recommendations/remoteAnalysisHotSetSweep";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    adminUrl && databaseName ? describe : describe.skip;
const day = 24 * 60 * 60 * 1_000;

describeWithPostgres("active analysis accounts in PostgreSQL", () => {
    let admin: Client;

    beforeAll(async () => {
        admin = await createScaleDatabase(adminUrl!, databaseName!);
        await applyScaleMigrations(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
        await prisma.play.deleteMany();
        await prisma.user.deleteMany();
        (remoteAnalysisHotSetScheduler.schedule as jest.Mock).mockResolvedValue(
            undefined,
        );
    });
    afterEach(() => stopRemoteAnalysisHotSetSweep());
    afterAll(async () => {
        await prisma.$disconnect();
        if (admin && databaseName) await dropScaleDatabase(admin, databaseName);
    });

    async function sweep(): Promise<string[]> {
        await new Promise<void>((resolve, reject) => {
            mockCompleted.mockImplementation(() => resolve());
            mockFailed.mockImplementation((_message, context) =>
                reject(context.error),
            );
            startRemoteAnalysisHotSetSweep();
        });
        return (
            remoteAnalysisHotSetScheduler.schedule as jest.Mock
        ).mock.calls.map(([request]) => request.userId);
    }

    it("does not let 1001 plays from one listener hide a quieter active listener", async () => {
        const now = Date.now();
        await prisma.user.createMany({
            data: ["heavy", "quiet", "stale", "test"].map((id) => ({
                id,
                username: id,
                isTestAccount: id === "test",
            })),
        });
        await prisma.play.createMany({
            data: [
                ...Array.from({ length: 1_001 }, (_, index) => ({
                    userId: "heavy",
                    playedAt: new Date(now - index * 1_000),
                })),
                { userId: "quiet", playedAt: new Date(now - day) },
                { userId: "stale", playedAt: new Date(now - 91 * day) },
                { userId: "test", playedAt: new Date(now + 1_000) },
            ],
        });

        await expect(sweep()).resolves.toEqual(["heavy", "quiet"]);
    });

    it("bounds distinct accounts to 100, ordered by last activity with stable ties", async () => {
        const ids = Array.from(
            { length: 103 },
            (_, i) => `user-${String(i).padStart(3, "0")}`,
        );
        await prisma.user.createMany({
            data: ids.map((id) => ({ id, username: id })),
        });
        const now = Date.now();
        await prisma.play.createMany({
            data: [
                ...ids.toReversed().map((userId) => ({
                    userId,
                    playedAt: new Date(now - day),
                })),
                { userId: "user-102", playedAt: new Date(now) },
            ],
        });

        await expect(sweep()).resolves.toEqual([
            "user-102",
            ...ids.slice(0, 99),
        ]);
    });

    it("does not schedule inactive accounts or test-only activity", async () => {
        await prisma.user.createMany({
            data: [
                { id: "inactive", username: "inactive" },
                { id: "test", username: "test", isTestAccount: true },
            ],
        });
        await prisma.play.create({ data: { userId: "test" } });

        await expect(sweep()).resolves.toEqual([]);
    });
});
