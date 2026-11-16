import type { Prisma } from "@prisma/client";
import { PlayAccountingError } from "./playAccountingProtocol";

/** Shared owner fence for accepted Plays, destination changes, claims and revocation. */
export interface PlayAccountingOwner {
    id: string;
    epoch: number;
    prunedThrough: Date | null;
    tokenVersion: number;
}

/** Acquires the same PostgreSQL row lock before any account-owned dispatch mutation. */
export async function lockPlayAccountingOwner(
    transaction: Prisma.TransactionClient,
    userId: string,
): Promise<PlayAccountingOwner> {
    const owners = await transaction.$queryRaw<PlayAccountingOwner[]>`
        SELECT "id", "playHistoryEpoch" AS "epoch", "playReceiptPrunedThrough" AS "prunedThrough", "tokenVersion"
        FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE
    `;
    if (!owners[0]) throw new PlayAccountingError(404, "play_owner_not_found");
    return owners[0];
}
