import type { PrismaClient } from "@prisma/client";
jest.mock("../../config", () => ({
    config: {
        playCreation: { newCreationsEnabled: false, replaySupported: false },
    },
}));
jest.mock("../../utils/db", () => ({ prisma: {} }));
import { createPlayAccounting } from "../playAccounting";

test("capability v1 has the ADR owner/time/freshness contract while activation remains off", async () => {
    const database = {
        user: {
            findUniqueOrThrow: jest
                .fn()
                .mockResolvedValue({ playHistoryEpoch: 7 }),
        },
    };
    const service = createPlayAccounting(
        database as unknown as PrismaClient,
        { newCreationsEnabled: false, replaySupported: false },
        () => new Date(1_700_000_000_000),
    );
    expect(await service.capabilities("fixture-owner")).toEqual({
        version: 1,
        newCreationsEnabled: false,
        replaySupported: false,
        createPath: "/api/plays/idempotent",
        allowedSources: [],
        ownerHistoryEpoch: 7,
        serverNowMs: 1_700_000_000_000,
        replayWindowSeconds: 86_400,
        futureSkewSeconds: 300,
        capabilityTtlSeconds: 300,
    });
    expect(database.user.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: "fixture-owner" },
        select: { playHistoryEpoch: true },
    });
});
