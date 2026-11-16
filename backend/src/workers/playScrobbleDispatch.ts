import { randomUUID } from "node:crypto";
import {
    Prisma,
    type PrismaClient,
    type PlayScrobbleDispatchState,
} from "@prisma/client";
import { lockPlayAccountingOwner } from "../services/playAccountingOwner";
import { PlayAccountingError } from "../services/playAccountingProtocol";
import { invalidateScrobbleAuthorization } from "../services/playScrobbleDispatchStore";
import {
    scrobbleDispatchWakeSchema,
    scrobbleDispatchTrackSchema,
    type ScrobbleDispatchAck,
} from "../services/playScrobbleProtocol";
import {
    ScrobbleBeforeHandoffError,
    type ScrobbleDispatchSubmission,
} from "../services/playScrobbleSubmission";
import type { ScrobbleService } from "../services/scrobbleTypes";

/** Ephemeral preparation and transport happen outside every accounting owner lock. */
export interface PlayScrobbleDispatcherDependencies {
    submit(input: ScrobbleDispatchSubmission): Promise<ScrobbleDispatchAck>;
    decryptCredential(ciphertext: string): string | Promise<string>;
    resolveLastFmCredentials(): Promise<{
        apiKey: string;
        sharedSecret: string;
    }>;
    clock?: () => Date;
    record?(service: string, state: string, reason: string): void;
}

/** Authoritative DB claim gate: one winning claim permits at most one automatic HTTP handoff. */
export function createPlayScrobbleDispatcher(
    database: PrismaClient,
    dependencies: PlayScrobbleDispatcherDependencies,
) {
    const clock = dependencies.clock ?? (() => new Date());
    const transactionOptions = { maxWait: 5_000, timeout: 5_000 };
    return async (
        wake: unknown,
    ): Promise<PlayScrobbleDispatchState | "ignored"> => {
        const parsed = scrobbleDispatchWakeSchema.safeParse(wake);
        if (!parsed.success) return "ignored";
        const { dispatchId, userId } = parsed.data;
        const claimToken = randomUUID();
        const mutateTerminal = async (
            transaction: Prisma.TransactionClient,
            state: PlayScrobbleDispatchState,
            reason: string,
            from: "PENDING" | "CLAIMED",
        ) => {
            const result = await transaction.playScrobbleDispatch.updateMany({
                where: {
                    id: dispatchId,
                    userId,
                    state: from,
                    ...(from === "CLAIMED" ? { claimToken } : {}),
                },
                data: {
                    state,
                    reason,
                    completedAt: clock(),
                    metadata: Prisma.DbNull,
                    claimToken: null,
                    claimExpiresAt: null,
                },
            });
            return result.count > 0;
        };
        let claim;
        try {
            claim = await database.$transaction(async (transaction) => {
                const owner = await lockPlayAccountingOwner(
                    transaction,
                    userId,
                );
                const row = await transaction.playScrobbleDispatch.findFirst({
                    where: { id: dispatchId, userId, state: "PENDING" },
                    include: {
                        connection: true,
                        play: { select: { userId: true } },
                    },
                });
                if (!row || row.availableAt > clock()) return null;
                const terminal = async (
                    state: PlayScrobbleDispatchState,
                    reason: string,
                ) => {
                    await mutateTerminal(transaction, state, reason, "PENDING");
                    return null;
                };
                if (row.expiresAt <= clock())
                    return terminal("CANCELLED", "expired");
                if (owner.tokenVersion !== row.userTokenVersion)
                    return terminal("CANCELLED", "authorization_revoked");
                if (
                    !row.play ||
                    row.play.userId !== userId ||
                    !row.connection ||
                    row.connection.userId !== userId ||
                    row.connection.service !== row.service
                )
                    return terminal("NO_TARGET", "destination_missing");
                if (
                    row.connection.authEpoch !== row.authEpoch ||
                    !row.connection.enabled
                )
                    return terminal("CANCELLED", "authorization_revoked");
                if (!row.connection.encryptedCredential)
                    return terminal("NO_TARGET", "destination_missing");
                if (row.service !== "lastfm" && row.service !== "listenbrainz")
                    return terminal("NO_TARGET", "destination_missing");
                const track = scrobbleDispatchTrackSchema.safeParse(
                    row.metadata,
                );
                if (!track.success)
                    return terminal("REJECTED", "metadata_invalid");
                if (row.attemptCount >= 3)
                    return terminal(
                        "FAILED_NOT_SENT",
                        "configuration_unavailable",
                    );
                const now = clock();
                const changed =
                    await transaction.playScrobbleDispatch.updateMany({
                        where: {
                            id: dispatchId,
                            userId,
                            state: "PENDING",
                            attemptCount: row.attemptCount,
                        },
                        data: {
                            state: "CLAIMED",
                            claimToken,
                            claimedAt: now,
                            claimExpiresAt: new Date(now.getTime() + 30_000),
                            attemptCount: { increment: 1 },
                        },
                    });
                if (!changed.count) return null;
                return {
                    connectionId: row.connection.id,
                    authEpoch: row.authEpoch,
                    userTokenVersion: row.userTokenVersion,
                    ciphertext: row.connection.encryptedCredential,
                    service: row.service as ScrobbleService,
                    track: track.data,
                    listenedAtSeconds: Math.floor(
                        row.listenedAt.getTime() / 1000,
                    ),
                    attemptCount: row.attemptCount + 1,
                };
            }, transactionOptions);
        } catch (error) {
            if (error instanceof PlayAccountingError && error.status === 404)
                return "ignored";
            throw error;
        }
        if (!claim) return "ignored";

        const finish = async (
            ack: ScrobbleDispatchAck | ScrobbleBeforeHandoffError,
        ): Promise<PlayScrobbleDispatchState | "ignored"> => {
            const currentClaim = claim;
            if (!currentClaim) return "ignored";
            const result = await database.$transaction(async (transaction) => {
                await lockPlayAccountingOwner(transaction, userId);
                const row = await transaction.playScrobbleDispatch.findFirst({
                    where: {
                        id: dispatchId,
                        userId,
                        state: "CLAIMED",
                        claimToken,
                    },
                });
                if (!row) return null;
                let state: PlayScrobbleDispatchState;
                let reason: string;
                if (!row.claimExpiresAt || row.claimExpiresAt <= clock()) {
                    state = "AMBIGUOUS";
                    reason = "claim_expired";
                } else if (ack instanceof ScrobbleBeforeHandoffError) {
                    reason = ack.reason;
                    state =
                        ack.reason === "metadata_invalid"
                            ? "REJECTED"
                            : row.attemptCount < 3 && row.expiresAt > clock()
                              ? "PENDING"
                              : "FAILED_NOT_SENT";
                } else {
                    state =
                        ack === "submitted"
                            ? "SUBMITTED"
                            : ack === "rejected"
                              ? "REJECTED"
                              : ack === "invalid_auth"
                                ? "INVALID_AUTH"
                                : "AMBIGUOUS";
                    reason =
                        ack === "submitted"
                            ? "ack_submitted"
                            : ack === "rejected"
                              ? "ack_rejected"
                              : ack === "invalid_auth"
                                ? "invalid_auth"
                                : "unknown_ack";
                }
                if (state === "PENDING") {
                    await transaction.playScrobbleDispatch.updateMany({
                        where: {
                            id: dispatchId,
                            userId,
                            state: "CLAIMED",
                            claimToken,
                        },
                        data: {
                            state,
                            reason,
                            availableAt: new Date(
                                clock().getTime() +
                                    5_000 * 2 ** (row.attemptCount - 1),
                            ),
                            claimToken: null,
                            claimExpiresAt: null,
                        },
                    });
                } else
                    await mutateTerminal(transaction, state, reason, "CLAIMED");
                if (state === "INVALID_AUTH")
                    await invalidateScrobbleAuthorization(
                        transaction,
                        {
                            userId,
                            service: currentClaim.service,
                            encryptedCredential: currentClaim.ciphertext,
                            connectionId: currentClaim.connectionId,
                            authEpoch: currentClaim.authEpoch,
                        },
                        clock(),
                    );
                return { state, reason };
            }, transactionOptions);
            if (!result) return "ignored";
            dependencies.record?.(
                currentClaim.service,
                result.state,
                result.reason,
            );
            return result.state;
        };

        let submission: ScrobbleDispatchSubmission;
        try {
            const credential = await dependencies.decryptCredential(
                claim.ciphertext,
            );
            const lastFm =
                claim.service === "lastfm"
                    ? await dependencies.resolveLastFmCredentials()
                    : undefined;
            submission = {
                service: claim.service,
                credential,
                lastFm,
                track: claim.track,
                listenedAtSeconds: claim.listenedAtSeconds,
            };
        } catch {
            return finish(
                new ScrobbleBeforeHandoffError("configuration_unavailable"),
            );
        }
        // Last permission check immediately before handoff. A later revocation is an in-flight boundary.
        const permitted = await database.$transaction(async (transaction) => {
            const owner = await lockPlayAccountingOwner(transaction, userId);
            const row = await transaction.playScrobbleDispatch.findFirst({
                where: { id: dispatchId, userId, state: "CLAIMED", claimToken },
                include: { connection: true },
            });
            if (!row) return false;
            const now = clock();
            if (!row.claimExpiresAt || row.claimExpiresAt <= now) {
                await mutateTerminal(
                    transaction,
                    "AMBIGUOUS",
                    "claim_expired",
                    "CLAIMED",
                );
                return false;
            }
            if (
                row.expiresAt <= now ||
                !row.playId ||
                owner.tokenVersion !== row.userTokenVersion ||
                !row.connection ||
                row.connection.id !== claim.connectionId ||
                row.connection.authEpoch !== claim.authEpoch ||
                !row.connection.enabled ||
                row.connection.encryptedCredential !== claim.ciphertext
            ) {
                await mutateTerminal(
                    transaction,
                    "AMBIGUOUS",
                    "revoked_inflight",
                    "CLAIMED",
                );
                return false;
            }
            return true;
        }, transactionOptions);
        if (!permitted) return "ignored";
        let ack: ScrobbleDispatchAck | ScrobbleBeforeHandoffError;
        try {
            ack = await dependencies.submit(submission);
        } catch (error) {
            ack =
                error instanceof ScrobbleBeforeHandoffError
                    ? error
                    : "ambiguous";
        }
        return finish(ack);
    };
}
