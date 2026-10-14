import { prisma, Prisma } from "../utils/db";
import { hasErrorCode, isForeignKeyViolationOn } from "../utils/prismaErrors";

/** A failed lease never grants permission to retry with a newer revision. */
export class PlaybackStateConflictError extends Error {
    constructor() {
        super("Playback state has changed");
        this.name = "PlaybackStateConflictError";
    }
}

/** Sanitized create/update payloads for one user/device slot. */
export type PlaybackStateMutation = {
    where: Prisma.PlaybackStateWhereUniqueInput;
    update: Prisma.PlaybackStateUncheckedUpdateManyInput;
    create: Prisma.PlaybackStateUncheckedCreateInput;
};

async function commit(args: PlaybackStateMutation, expectedRevision: string) {
    if (expectedRevision === "absent") {
        try {
            return await prisma.playbackState.create({ data: args.create });
        } catch (error: unknown) {
            if (hasErrorCode(error, "P2002")) {
                throw new PlaybackStateConflictError();
            }
            throw error;
        }
    }

    // UPDATE owns the row lock until this transaction's read has obtained the
    // trigger-generated revision. The comparison is part of the SQL predicate.
    return prisma.$transaction(async (tx) => {
        const result = await tx.playbackState.updateMany({
            where: {
                userId: args.create.userId,
                deviceId: args.create.deviceId,
                revision: expectedRevision,
            },
            data: args.update,
        });
        if (result.count !== 1) throw new PlaybackStateConflictError();
        return tx.playbackState.findUniqueOrThrow({ where: args.where });
    });
}

/** Atomically mutate one slot, retrying a deleted audiobook with the same lease. */
export async function compareAndSetPlaybackState(
    args: PlaybackStateMutation,
    expectedRevision: string,
) {
    try {
        return await commit(args, expectedRevision);
    } catch (error: unknown) {
        if (!isForeignKeyViolationOn(error, "PlaybackState_audiobookId_fkey")) {
            throw error;
        }
        // PostgreSQL aborts the failed transaction. Retry the entire CAS outside
        // it; a concurrent winner makes this original revision fail with 412.
        return commit(
            {
                ...args,
                update: { ...args.update, audiobookId: null },
                create: { ...args.create, audiobookId: null },
            },
            expectedRevision,
        );
    }
}
