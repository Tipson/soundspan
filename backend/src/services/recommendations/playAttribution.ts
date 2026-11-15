import type { Prisma } from "@prisma/client";
import { monotonicEngagementFilter } from "../playAccountingProtocol";
const SEVEN_DAYS_MS = 7 * 86_400_000;

interface PlaybackProjection {
    exposureId: string;
    userId?: string;
    playId: string;
    playedAt: Date;
    listenedSeconds: number | null;
    completionRatio: number | null;
    outcome: string | null;
}

/** Conditional projection serializes concurrent legacy and keyed runs in SQL. */
export async function projectPlaybackAttribution(
    transaction: Prisma.TransactionClient,
    input: PlaybackProjection,
): Promise<void> {
    await transaction.recommendationExposure.updateMany({
        where: {
            id: input.exposureId,
            ...(input.userId ? { userId: input.userId } : {}),
            OR: [
                {
                    lastPlayAt: null,
                    OR: [
                        { playedAt: null },
                        { playedAt: { lte: input.playedAt } },
                    ],
                },
                { lastPlayAt: { lt: input.playedAt } },
                {
                    lastPlayAt: input.playedAt,
                    lastPlayId: { lt: input.playId },
                },
                {
                    lastPlayAt: input.playedAt,
                    lastPlayId: input.playId,
                    ...(input.listenedSeconds !== null &&
                    input.completionRatio !== null &&
                    ["failed", "skipped", "meaningful", "completed"].includes(
                        input.outcome ?? "",
                    )
                        ? monotonicEngagementFilter({
                              listenedSeconds: input.listenedSeconds,
                              completionRatio: input.completionRatio,
                              outcome: input.outcome as
                                  | "failed"
                                  | "skipped"
                                  | "meaningful"
                                  | "completed",
                          })
                        : { listenedSeconds: null, completionRatio: null }),
                },
            ],
        },
        data: {
            playedAt: input.playedAt,
            lastPlayAt: input.playedAt,
            lastPlayId: input.playId,
            listenedSeconds: input.listenedSeconds,
            completionRatio: input.completionRatio,
            outcome: input.outcome,
        },
    });
}

/** Selects exactly once while the Play's owner lock is held, then freezes the target. */
export async function freezePlaybackAttribution(
    transaction: Prisma.TransactionClient,
    input: {
        userId: string;
        playId: string;
        playedAt: Date;
        provider: string;
        providerTrackId: string;
        generationId?: string;
    },
): Promise<string | null> {
    const identity = {
        userId: input.userId,
        provider: input.provider,
        providerTrackId: input.providerTrackId,
        generation: { served: true, userId: input.userId },
    };
    const direct = input.generationId
        ? await transaction.recommendationExposure.findFirst({
              where: {
                  ...identity,
                  generationId: input.generationId,
              },
              select: { id: true },
          })
        : null;
    const exposure =
        direct ??
        (await transaction.recommendationExposure.findFirst({
            where: {
                ...identity,
                viewedAt: {
                    gte: new Date(input.playedAt.getTime() - SEVEN_DAYS_MS),
                    lte: input.playedAt,
                },
            },
            orderBy: [{ viewedAt: "desc" }, { id: "desc" }],
            select: { id: true },
        }));
    if (!exposure) return null;
    await transaction.recommendationExposure.updateMany({
        where: { id: exposure.id, userId: input.userId, viewedAt: null },
        data: { viewedAt: input.playedAt },
    });
    await projectPlaybackAttribution(transaction, {
        ...input,
        exposureId: exposure.id,
        listenedSeconds: null,
        completionRatio: null,
        outcome: null,
    });
    return exposure.id;
}
