import type { Prisma, PrismaClient } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import {
    freezePlaybackAttribution,
    projectPlaybackAttribution,
} from "./recommendations/playAttribution";
import {
    assertPlayKeyCurrent,
    hashPlayCreationRequest,
    monotonicEngagementFilter,
    parsePlayCreationKey,
    PlayAccountingError,
    type PlayCreationPayload,
    type PlayEngagement,
    playPayloadSchema,
} from "./playAccountingProtocol";

/** Activation stays disabled until durable external delivery and clients are ready. */
export interface PlayCreationPolicy {
    newCreationsEnabled: boolean;
    replaySupported: boolean;
}
/** Only server-resolved shared identities may be prepared outside the owner lock. */
export interface PreparedPlayIdentity {
    trackYtMusicId?: string;
}
/** Commit observation starts at an actual write and finishes after the outer transaction. */
export interface PlayWriteObservation {
    committed(): void;
    failed(): void;
}
type Owner = { id: string; epoch: number; prunedThrough: Date | null };

async function lockOwner(
    transaction: Prisma.TransactionClient,
    userId: string,
): Promise<Owner> {
    const owners = await transaction.$queryRaw<Owner[]>`
        SELECT "id", "playHistoryEpoch" AS "epoch", "playReceiptPrunedThrough" AS "prunedThrough"
        FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE
    `;
    if (!owners[0]) throw new PlayAccountingError(404, "play_owner_not_found");
    return owners[0];
}

/** Owns the Play/receipt/history boundary; never performs provider HTTP under its lock. */
export function createPlayAccounting(
    database: PrismaClient,
    policy: PlayCreationPolicy,
    clock = () => new Date(),
) {
    const transactionOptions = { maxWait: 5_000, timeout: 5_000 };
    return {
        async capabilities(userId: string) {
            const owner = await database.user.findUniqueOrThrow({
                where: { id: userId },
                select: { playHistoryEpoch: true },
            });
            return {
                version: 1,
                newCreationsEnabled: policy.newCreationsEnabled,
                replaySupported: policy.replaySupported,
                createPath: "/api/plays/idempotent",
                ownerHistoryEpoch: owner.playHistoryEpoch,
                serverNowMs: clock().getTime(),
                replayWindowSeconds: 86_400,
                futureSkewSeconds: 300,
                capabilityTtlSeconds: 300,
                allowedSources: policy.newCreationsEnabled
                    ? ["youtube", "vk", "yandex"]
                    : [],
            };
        },

        async createOrReplay(
            userId: string,
            clientPlaybackId: unknown,
            payload: PlayCreationPayload,
            prepare: () => Promise<PreparedPlayIdentity>,
            observeWrite?: () => PlayWriteObservation,
        ) {
            // Snapshot at the module boundary; asynchronous preparation cannot mutate
            // what the receipt hash authorizes even for an in-process caller.
            payload = playPayloadSchema.parse(payload);
            const key = parsePlayCreationKey(clientPlaybackId);
            const identifier = clientPlaybackId as string;
            const requestHash = hashPlayCreationRequest(payload);
            if (payload.trackId || payload.tidalTrackId)
                throw new PlayAccountingError(
                    400,
                    "play_creation_source_not_supported",
                );
            const acknowledge = (
                id: string,
                disposition: "created" | "replayed",
            ) => ({
                id,
                playCreation: {
                    version: 1,
                    clientPlaybackId: identifier,
                    disposition,
                    replayExpiresAt: new Date(key.expiresAtMs).toISOString(),
                },
            });
            const inspect = async (transaction: Prisma.TransactionClient) => {
                const owner = await lockOwner(transaction, userId);
                assertPlayKeyCurrent(key, owner, clock().getTime());
                const receipt =
                    await transaction.playCreationReceipt.findUnique({
                        where: {
                            userId_clientPlaybackId: {
                                userId,
                                clientPlaybackId: identifier,
                            },
                        },
                    });
                if (receipt) {
                    if (!policy.replaySupported)
                        throw new PlayAccountingError(
                            503,
                            "play_creation_disabled",
                        );
                    if (receipt.deletedAt || !receipt.playId)
                        throw new PlayAccountingError(410, "play_deleted");
                    if (receipt.requestHash !== requestHash)
                        throw new PlayAccountingError(
                            409,
                            "play_key_payload_conflict",
                        );
                    return acknowledge(receipt.playId, "replayed");
                }
                if (!policy.newCreationsEnabled || !policy.replaySupported)
                    throw new PlayAccountingError(
                        503,
                        "play_creation_disabled",
                    );
                return null;
            };
            // Replay never contacts a metadata service. Release the lock for preparation,
            // then recheck every admission invariant under the same owner's lock.
            const replay = await database.$transaction(
                inspect,
                transactionOptions,
            );
            if (replay) return replay;
            const prepared = await prepare();
            let observation: PlayWriteObservation | undefined;
            try {
                const result = await database.$transaction(
                    async (transaction) => {
                        const racedReplay = await inspect(transaction);
                        if (racedReplay) return racedReplay;
                        const playedAt = clock();
                        const generation = payload.recommendationGenerationId
                            ? await transaction.recommendationGeneration.findFirst(
                                  {
                                      where: {
                                          id: payload.recommendationGenerationId,
                                          userId,
                                          served: true,
                                      },
                                      select: { id: true },
                                  },
                              )
                            : null;
                        observation = observeWrite?.();
                        let data: Prisma.PlayUncheckedCreateInput;
                        const recording = payload.musicSourceRecording;
                        if (recording) {
                            const identity =
                                await transaction.trackMusicSource.upsert({
                                    where: {
                                        provider_providerTrackId: {
                                            provider: recording.provider,
                                            providerTrackId: recording.id,
                                        },
                                    },
                                    update: { providerTrackId: recording.id },
                                    create: {
                                        provider: recording.provider,
                                        providerTrackId: recording.id,
                                    },
                                });
                            data = {
                                userId,
                                trackMusicSourceId: identity.id,
                                musicSourceRecording: recording,
                                source:
                                    recording.provider === "vk"
                                        ? "VK"
                                        : "YANDEX",
                            };
                        } else {
                            if (
                                !payload.youtubeVideoId ||
                                !prepared.trackYtMusicId
                            )
                                throw new PlayAccountingError(
                                    400,
                                    "play_creation_source_not_supported",
                                );
                            data = {
                                userId,
                                trackYtMusicId: prepared.trackYtMusicId,
                                source: "YOUTUBE_MUSIC",
                            };
                        }
                        const play = await transaction.play.create({
                            data: {
                                ...data,
                                playedAt,
                                playContext: payload.playContext,
                                waveMode: payload.waveMode,
                                recommendationGenerationId: generation?.id,
                                recommendationSessionId:
                                    payload.recommendationSessionId,
                                localAttributionState: "NO_TARGET",
                            },
                        });
                        const exposureId = await freezePlaybackAttribution(
                            transaction,
                            {
                                userId,
                                playId: play.id,
                                playedAt,
                                provider: recording?.provider ?? "youtube",
                                providerTrackId:
                                    recording?.id ?? payload.youtubeVideoId!,
                                generationId: generation?.id,
                            },
                        );
                        if (exposureId)
                            await transaction.play.update({
                                where: { id: play.id },
                                data: {
                                    localAttributionState: "APPLIED",
                                    attributedExposureId: exposureId,
                                },
                            });
                        await transaction.playCreationReceipt.create({
                            data: {
                                userId,
                                clientPlaybackId: identifier,
                                requestHash,
                                issuedAt: new Date(key.issuedAtMs),
                                expiresAt: new Date(key.expiresAtMs),
                                playId: play.id,
                            },
                        });
                        return acknowledge(play.id, "created");
                    },
                    transactionOptions,
                );
                observation?.committed();
                return result;
            } catch (error) {
                observation?.failed();
                throw error;
            }
        },

        /** null means historical LEGACY: retain its existing best-effort adapter. */
        async updateEngagement(
            userId: string,
            id: string,
            engagement: PlayEngagement,
            observeWrite?: () => PlayWriteObservation,
        ) {
            let observation: PlayWriteObservation | undefined;
            try {
                const result = await database.$transaction(
                    async (transaction) => {
                        await lockOwner(transaction, userId);
                        const play = await transaction.play.findFirst({
                            where: { id, userId },
                        });
                        if (!play)
                            throw new PlayAccountingError(
                                404,
                                "play_not_found",
                            );
                        if (play.localAttributionState === "LEGACY")
                            return null;
                        observation = observeWrite?.();
                        const result = await transaction.play.updateMany({
                            where: {
                                id,
                                userId,
                                ...monotonicEngagementFilter(engagement),
                            },
                            data: {
                                ...engagement,
                                engagementUpdatedAt: clock(),
                            },
                        });
                        if (!result.count)
                            return { success: true, stale: true };
                        if (
                            play.localAttributionState === "APPLIED" &&
                            play.attributedExposureId
                        )
                            await projectPlaybackAttribution(transaction, {
                                exposureId: play.attributedExposureId,
                                userId,
                                playId: id,
                                playedAt: play.playedAt,
                                ...engagement,
                            });
                        return { success: true };
                    },
                    transactionOptions,
                );
                observation?.committed();
                return result;
            } catch (error) {
                observation?.failed();
                throw error;
            }
        },

        async clearHistory(
            userId: string,
            range: "7d" | "30d" | "365d" | "all",
        ) {
            return database.$transaction(async (transaction) => {
                const owner = await lockOwner(transaction, userId);
                if (owner.epoch === 2_147_483_647)
                    throw new PlayAccountingError(
                        503,
                        "play_history_epoch_exhausted",
                    );
                const now = clock();
                const days = range === "7d" ? 7 : range === "30d" ? 30 : 365;
                const where: Prisma.PlayWhereInput = {
                    userId,
                    ...(range === "all"
                        ? {}
                        : {
                              playedAt: {
                                  gte: new Date(
                                      now.getTime() - days * 86_400_000,
                                  ),
                                  lte: now,
                              },
                          }),
                };
                await transaction.user.update({
                    where: { id: userId },
                    data: { playHistoryEpoch: { increment: 1 } },
                });
                await transaction.playCreationReceipt.updateMany({
                    where: { userId, play: where },
                    data: { deletedAt: now, requestHash: null },
                });
                return transaction.play.deleteMany({ where });
            }, transactionOptions);
        },

        async pruneExpiredReceipts(userId: string, limit = 100) {
            if (!Number.isInteger(limit) || limit < 1 || limit > 100)
                throw new RangeError("Receipt batch must be between 1 and 100");
            return database.$transaction(async (transaction) => {
                const owner = await lockOwner(transaction, userId);
                const receipts = await transaction.playCreationReceipt.findMany(
                    {
                        where: {
                            userId,
                            expiresAt: {
                                lt: new Date(clock().getTime() - 300_000),
                            },
                        },
                        orderBy: [
                            { issuedAt: "asc" },
                            { clientPlaybackId: "asc" },
                        ],
                        take: limit,
                        select: { clientPlaybackId: true, issuedAt: true },
                    },
                );
                if (!receipts.length) return 0;
                const floor = new Date(
                    Math.max(
                        owner.prunedThrough?.getTime() ?? 0,
                        ...receipts.map((receipt) =>
                            receipt.issuedAt.getTime(),
                        ),
                    ),
                );
                await transaction.user.update({
                    where: { id: userId },
                    data: { playReceiptPrunedThrough: floor },
                });
                const result = await transaction.playCreationReceipt.deleteMany(
                    {
                        where: {
                            userId,
                            clientPlaybackId: {
                                in: receipts.map(
                                    (receipt) => receipt.clientPlaybackId,
                                ),
                            },
                        },
                    },
                );
                return result.count;
            }, transactionOptions);
        },
    };
}

/** Process adapter; activation policy is intentionally unavailable through environment. */
export const playAccounting = createPlayAccounting(prisma, config.playCreation);
