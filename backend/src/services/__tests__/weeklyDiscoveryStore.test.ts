import type { PrismaClient } from "@prisma/client";
import { PrismaWeeklyDiscoveryStore } from "../weeklyDiscoveryStore";

function fixture(error?: unknown) {
    const row = {
        id: "generation",
        context: {
            weeklyDiscovery: {
                version: 1,
                weekStart: "2026-10-05T00:00:00.000Z",
                cleared: true,
                tracks: [],
            },
        },
    };
    const findFirst = jest.fn(async () => row);
    const transaction = jest.fn(
        async (callback: (tx: unknown) => Promise<unknown>) =>
            callback({
                recommendationGeneration: {
                    findFirst,
                    update: jest.fn(async () => row),
                },
            }),
    );
    if (error) transaction.mockRejectedValueOnce(error);
    const client = {
        recommendationGeneration: { findFirst },
        $transaction: transaction,
    } as unknown as PrismaClient;
    return {
        store: new PrismaWeeklyDiscoveryStore(client),
        transaction,
        findFirst,
        row,
    };
}
it("retries the actual Prisma PostgreSQL adapter's commit-time write conflict", async () => {
    const f = fixture({
        name: "DriverAdapterError",
        cause: { kind: "TransactionWriteConflict" },
    });
    await expect(
        f.store.clear("owner", "2026-10-05T00:00:00.000Z"),
    ).resolves.toBe(0);
    expect(f.transaction).toHaveBeenCalledTimes(2);
});
it("does not retry a non-conflict adapter error", async () => {
    const error = {
        name: "DriverAdapterError",
        cause: { kind: "UniqueConstraintViolation" },
    };
    const f = fixture(error);
    await expect(
        f.store.clear("owner", "2026-10-05T00:00:00.000Z"),
    ).rejects.toEqual(error);
    expect(f.transaction).toHaveBeenCalledTimes(1);
});
it("retries P2034 regardless of adapter metadata shape", async () => {
    const f = fixture({
        code: "P2034",
        meta: { driverAdapterError: { cause: { code: 40001 } } },
    });
    await expect(
        f.store.clear("owner", "2026-10-05T00:00:00.000Z"),
    ).resolves.toBe(0);
    expect(f.transaction).toHaveBeenCalledTimes(2);
});
it("bounds conflict retries to three transactions", async () => {
    const f = fixture();
    const error = { code: "P2034" };
    f.transaction.mockRejectedValue(error);
    await expect(
        f.store.clear("owner", "2026-10-05T00:00:00.000Z"),
    ).rejects.toEqual(error);
    expect(f.transaction).toHaveBeenCalledTimes(3);
});
it("fails closed if a stored snapshot belongs to a different week", async () => {
    const f = fixture();
    await expect(
        f.store.find("owner", "2026-10-12T00:00:00.000Z"),
    ).rejects.toThrow("Invalid weekly discovery snapshot");
});
