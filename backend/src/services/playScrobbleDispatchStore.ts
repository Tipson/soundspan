import { Prisma } from "@prisma/client";
import {
    playScrobbleDispatchId,
    scrobbleDispatchTrackSchema,
} from "./playScrobbleProtocol";
import { SCROBBLE_SERVICES, type ScrobbleTrack } from "./scrobbleTypes";

/** A generation cannot wrap and accidentally reauthorize an old destination. */
export function assertScrobbleAuthEpochAvailable(epoch: number): void {
    if (!Number.isInteger(epoch) || epoch < 0 || epoch >= 2_147_483_647)
        throw new Error("scrobble_auth_epoch_exhausted");
}

/** Revocation cannot promise to cancel an already claimed external request. */
export async function cancelPlayScrobbleDispatches(
    transaction: Prisma.TransactionClient,
    where: Prisma.PlayScrobbleDispatchWhereInput,
    now: Date,
    reason: "history_cleared" | "connection_changed" | "invalid_auth",
): Promise<void> {
    await transaction.playScrobbleDispatch.updateMany({
        where: { ...where, state: "PENDING" },
        data: {
            state: "CANCELLED",
            reason,
            completedAt: now,
            metadata: Prisma.DbNull,
            claimToken: null,
            claimExpiresAt: null,
        },
    });
    await transaction.playScrobbleDispatch.updateMany({
        where: { ...where, state: "CLAIMED" },
        data: {
            state: "AMBIGUOUS",
            reason: "revoked_inflight",
            completedAt: now,
            metadata: Prisma.DbNull,
            claimToken: null,
            claimExpiresAt: null,
        },
    });
}

/** Invalid-auth CAS cannot disable a replacement credential or authorization generation. */
export async function invalidateScrobbleAuthorization(
    transaction: Prisma.TransactionClient,
    input: {
        userId: string;
        service: string;
        encryptedCredential: string;
        connectionId?: string;
        authEpoch?: number;
    },
    now: Date,
): Promise<boolean> {
    const connection = await transaction.scrobbleConnection.findFirst({
        where: {
            userId: input.userId,
            service: input.service,
            enabled: true,
            encryptedCredential: input.encryptedCredential,
            ...(input.connectionId ? { id: input.connectionId } : {}),
            ...(input.authEpoch !== undefined
                ? { authEpoch: input.authEpoch }
                : {}),
        },
        select: { id: true, authEpoch: true },
    });
    if (!connection) return false;
    assertScrobbleAuthEpochAvailable(connection.authEpoch);
    const changed = await transaction.scrobbleConnection.updateMany({
        where: {
            id: connection.id,
            userId: input.userId,
            authEpoch: connection.authEpoch,
            encryptedCredential: input.encryptedCredential,
            enabled: true,
        },
        data: { enabled: false, authEpoch: { increment: 1 } },
    });
    if (!changed.count) return false;
    await cancelPlayScrobbleDispatches(
        transaction,
        {
            userId: input.userId,
            connectionId: connection.id,
            authEpoch: connection.authEpoch,
        },
        now,
        "invalid_auth",
    );
    return true;
}

/** Freezes allowed destinations in the caller's Play/receipt/attribution transaction. */
export async function createPlayScrobbleIntents(
    transaction: Prisma.TransactionClient,
    input: {
        userId: string;
        playId: string;
        playedAt: Date;
        source: string;
        track?: ScrobbleTrack;
    },
): Promise<void> {
    // Client-claimed native metadata must never enter external dispatch or canonical metadata.
    if (input.source !== "YOUTUBE_MUSIC") return;
    const owner = await transaction.user.findUniqueOrThrow({
        where: { id: input.userId },
        select: { tokenVersion: true },
    });
    const connections = await transaction.scrobbleConnection.findMany({
        where: {
            userId: input.userId,
            enabled: true,
            encryptedCredential: { not: null },
            service: { in: [...SCROBBLE_SERVICES] },
        },
        select: { id: true, service: true, authEpoch: true },
        take: 2,
        orderBy: { service: "asc" },
    });
    const metadata = scrobbleDispatchTrackSchema.safeParse(input.track);
    for (const connection of connections) {
        await transaction.playScrobbleDispatch.create({
            data: {
                id: playScrobbleDispatchId(
                    input.playId,
                    connection.id,
                    connection.authEpoch,
                ),
                userId: input.userId,
                playId: input.playId,
                connectionId: connection.id,
                authEpoch: connection.authEpoch,
                userTokenVersion: owner.tokenVersion,
                service: connection.service,
                listenedAt: input.playedAt,
                metadata: metadata.success ? metadata.data : Prisma.DbNull,
                state: metadata.success ? "PENDING" : "REJECTED",
                reason: metadata.success ? null : "metadata_invalid",
                completedAt: metadata.success ? null : input.playedAt,
                availableAt: input.playedAt,
                createdAt: input.playedAt,
                expiresAt: new Date(input.playedAt.getTime() + 86_400_000),
            },
        });
    }
}
