import { prisma } from "../utils/db";
import { Prisma } from "@prisma/client";
import {
    buildGenericImportPlaylistMixId,
    GENERIC_IMPORT_COMMIT_RECONCILIATION_WARNING,
    GENERIC_IMPORT_RECONCILIATION_DEDUPE_WINDOW_MS,
} from "./genericImportIdentity";

/**
 * Lifecycle statuses used by generic import jobs.
 */
export type ImportJobLifecycleStatus =
    | "pending"
    | "resolving"
    | "creating_playlist"
    | "completed"
    | "failed"
    | "cancelled"
    | "cancelling";

/**
 * Summary counts persisted with each generic import job.
 */
export interface ImportJobSummary {
    total: number;
    local: number;
    youtube: number;
    tidal: number;
    unresolved: number;
}

/**
 * Stored representation for a generic import job.
 */
export interface StoredImportJob {
    id: string;
    userId: string;
    sourceType: string;
    sourceId: string;
    sourceUrl: string;
    normalizedSource: string;
    playlistName: string;
    requestedPlaylistName: string | null;
    status: ImportJobLifecycleStatus;
    progress: number;
    summary: ImportJobSummary;
    resolvedTracks: Prisma.JsonValue | null;
    createdPlaylistId: string | null;
    resolutionStartedAt: Date | null;
    resolutionProcessed: number;
    resolutionAttempt: number;
    estimatedRemainingSeconds: number | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Payload used when creating a new generic import job.
 */
export interface CreateImportJobInput {
    userId: string;
    sourceType: string;
    sourceId: string;
    sourceUrl: string;
    playlistName: string;
    requestedPlaylistName?: string;
    status?: ImportJobLifecycleStatus;
    progress?: number;
    summary: ImportJobSummary;
    resolvedTracks?: Prisma.InputJsonValue;
}

/**
 * Mutable fields for generic import job lifecycle updates.
 */
export interface UpdateImportJobInput {
    playlistName?: string;
    status?: ImportJobLifecycleStatus;
    progress?: number;
    summary?: ImportJobSummary;
    resolvedTracks?: Prisma.InputJsonValue | null;
    createdPlaylistId?: string | null;
    resolutionStartedAt?: Date | null;
    resolutionProcessed?: number;
    resolutionAttempt?: number;
    error?: string | null;
}

/**
 * Result of atomically claiming an active import job for a source.
 */
export interface ClaimImportJobResult {
    job: StoredImportJob;
    created: boolean;
}

/**
 * Outcome of an ownership-scoped, conditional cancellation request.
 */
export type RequestImportJobCancellationResult =
    | { outcome: "updated"; job: StoredImportJob }
    | { outcome: "not_found" | "forbidden"; job: null }
    | { outcome: "conflict"; job: StoredImportJob };

/** Outcome of an ownership-scoped retry for unresolved playlist positions. */
export type RequestImportJobRetryResult =
    | { outcome: "updated"; job: StoredImportJob }
    | { outcome: "not_found" | "forbidden"; job: null }
    | { outcome: "conflict"; job: StoredImportJob };

const ACTIVE_IMPORT_JOB_STATUSES: ImportJobLifecycleStatus[] = [
    "pending",
    "resolving",
    "creating_playlist",
    "cancelling",
];
const SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS = 3;

class ImportJobClaimRetryError extends Error {}

function toImportSummaryJson(summary: ImportJobSummary): Prisma.InputJsonValue {
    return {
        total: summary.total,
        local: summary.local,
        youtube: summary.youtube,
        tidal: summary.tidal,
        unresolved: summary.unresolved,
    };
}

function toNullableJsonUpdateValue(
    value: Prisma.InputJsonValue | null,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
    return value === null ? Prisma.JsonNull : value;
}

function buildNormalizedSource(sourceType: string, sourceId: string): string {
    return `${sourceType.trim().toLowerCase()}:${sourceId.trim()}`;
}

function buildJobUpdateData(input: UpdateImportJobInput) {
    return {
        ...(input.playlistName !== undefined
            ? { playlistName: input.playlistName }
            : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.progress !== undefined ? { progress: input.progress } : {}),
        ...(input.summary
            ? { summary: toImportSummaryJson(input.summary) }
            : {}),
        ...(input.resolvedTracks !== undefined
            ? {
                  resolvedTracks: toNullableJsonUpdateValue(
                      input.resolvedTracks,
                  ),
              }
            : {}),
        ...(input.createdPlaylistId !== undefined
            ? { createdPlaylistId: input.createdPlaylistId }
            : {}),
        ...(input.resolutionStartedAt !== undefined
            ? { resolutionStartedAt: input.resolutionStartedAt }
            : {}),
        ...(input.resolutionProcessed !== undefined
            ? { resolutionProcessed: input.resolutionProcessed }
            : {}),
        ...(input.resolutionAttempt !== undefined
            ? { resolutionAttempt: input.resolutionAttempt }
            : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
    };
}

function hasPrismaErrorCode(error: unknown, code: string): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === code
    );
}

function isWithinCommitReconciliationWindow(updatedAt: Date): boolean {
    const cutoff = Date.now() - GENERIC_IMPORT_RECONCILIATION_DEDUPE_WINDOW_MS;
    return updatedAt.getTime() >= cutoff;
}

type ImportJobPersistenceRecord = {
    id: string;
    userId: string;
    sourceType: string;
    sourceId: string;
    sourceUrl: string;
    normalizedSource: string;
    playlistName: string;
    requestedPlaylistName: string | null;
    status: string;
    progress: number;
    summary: Prisma.JsonValue;
    resolvedTracks: Prisma.JsonValue | null;
    createdPlaylistId: string | null;
    resolutionStartedAt: Date | null;
    resolutionProcessed: number;
    resolutionAttempt: number;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
};

function toStoredImportJob(
    record: ImportJobPersistenceRecord,
): StoredImportJob {
    const rawSummary = record.summary as unknown;
    const summary: ImportJobSummary =
        rawSummary && typeof rawSummary === "object"
            ? (rawSummary as ImportJobSummary)
            : {
                  total: 0,
                  local: 0,
                  youtube: 0,
                  tidal: 0,
                  unresolved: 0,
              };
    const startedAt = record.resolutionStartedAt ?? null;
    const processed = record.resolutionProcessed ?? 0;
    const remaining = Math.max(0, summary.total - processed);
    const elapsedSeconds = startedAt
        ? Math.max(1, (Date.now() - startedAt.getTime()) / 1000)
        : 0;
    const estimatedRemainingSeconds =
        startedAt && processed > 0 && remaining > 0
            ? Math.ceil(remaining / (processed / elapsedSeconds))
            : null;
    return {
        ...record,
        status: record.status as ImportJobLifecycleStatus,
        summary,
        resolutionStartedAt: startedAt,
        resolutionProcessed: processed,
        resolutionAttempt: record.resolutionAttempt ?? 0,
        estimatedRemainingSeconds,
    };
}

class ImportJobStore {
    /**
     * Persists a new generic import job for the universal import flow.
     */
    async createJob(input: CreateImportJobInput): Promise<StoredImportJob> {
        const created = await prisma.importJob.create({
            data: {
                userId: input.userId,
                sourceType: input.sourceType,
                sourceId: input.sourceId,
                sourceUrl: input.sourceUrl,
                normalizedSource: buildNormalizedSource(
                    input.sourceType,
                    input.sourceId,
                ),
                playlistName: input.playlistName,
                requestedPlaylistName: input.requestedPlaylistName ?? null,
                status: input.status ?? "pending",
                progress: input.progress ?? 0,
                summary: toImportSummaryJson(input.summary),
                ...(input.resolvedTracks !== undefined
                    ? { resolvedTracks: input.resolvedTracks }
                    : {}),
                createdPlaylistId: null,
                error: null,
            },
        });
        return toStoredImportJob(
            created as unknown as ImportJobPersistenceRecord,
        );
    }

    /**
     * Returns the active job for a user/source or creates exactly one new job.
     * A failed job whose deterministic owner-scoped playlist already committed
     * is reconciled and returned instead of creating a duplicate import.
     *
     * Serializable isolation turns the source lookup into a database-backed
     * correctness boundary. PostgreSQL aborts one transaction when concurrent
     * absent-row reads both try to create a job, and the retry observes the
     * winner instead of creating another active row.
     */
    async claimJob(input: CreateImportJobInput): Promise<ClaimImportJobResult> {
        const normalizedSource = buildNormalizedSource(
            input.sourceType,
            input.sourceId,
        );
        for (
            let attempt = 1;
            attempt <= SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS;
            attempt += 1
        ) {
            try {
                return await prisma.$transaction(
                    async (transaction) => {
                        const existing = await transaction.importJob.findFirst({
                            where: {
                                userId: input.userId,
                                normalizedSource,
                                status: {
                                    in: ACTIVE_IMPORT_JOB_STATUSES,
                                },
                            },
                            orderBy: { updatedAt: "desc" },
                        });
                        if (existing) {
                            return {
                                job: toStoredImportJob(
                                    existing as unknown as ImportJobPersistenceRecord,
                                ),
                                created: false,
                            };
                        }

                        const [latestTerminalJob] =
                            await transaction.importJob.findMany({
                                where: {
                                    userId: input.userId,
                                    normalizedSource,
                                    status: {
                                        in: [
                                            "failed",
                                            "completed",
                                            "cancelled",
                                        ],
                                    },
                                },
                                orderBy: { updatedAt: "desc" },
                                take: 1,
                            });
                        const isRecoverableTerminal =
                            latestTerminalJob?.status === "failed" ||
                            (latestTerminalJob?.status === "completed" &&
                                latestTerminalJob.error ===
                                    GENERIC_IMPORT_COMMIT_RECONCILIATION_WARNING &&
                                isWithinCommitReconciliationWindow(
                                    latestTerminalJob.updatedAt,
                                ));
                        if (latestTerminalJob && isRecoverableTerminal) {
                            const committedPlaylist =
                                await transaction.playlist.findUnique({
                                    where: {
                                        userId_mixId: {
                                            userId: input.userId,
                                            mixId: buildGenericImportPlaylistMixId(
                                                latestTerminalJob.id,
                                            ),
                                        },
                                    },
                                    select: { id: true },
                                });
                            if (committedPlaylist) {
                                if (
                                    latestTerminalJob.status === "completed" &&
                                    latestTerminalJob.createdPlaylistId ===
                                        committedPlaylist.id
                                ) {
                                    return {
                                        job: toStoredImportJob(
                                            latestTerminalJob as unknown as ImportJobPersistenceRecord,
                                        ),
                                        created: false,
                                    };
                                }
                                const reconciliation =
                                    await transaction.importJob.updateMany({
                                        where: {
                                            id: latestTerminalJob.id,
                                            userId: input.userId,
                                            status: "failed",
                                        },
                                        data: {
                                            status: "completed",
                                            progress: 100,
                                            createdPlaylistId:
                                                committedPlaylist.id,
                                            error: GENERIC_IMPORT_COMMIT_RECONCILIATION_WARNING,
                                            updatedAt: new Date(),
                                        },
                                    });
                                if (reconciliation.count > 0) {
                                    const reconciled =
                                        await transaction.importJob.findUnique({
                                            where: {
                                                id: latestTerminalJob.id,
                                            },
                                        });
                                    if (!reconciled) {
                                        throw new Error(
                                            "Import job disappeared during commit reconciliation",
                                        );
                                    }
                                    return {
                                        job: toStoredImportJob(
                                            reconciled as unknown as ImportJobPersistenceRecord,
                                        ),
                                        created: false,
                                    };
                                }
                                throw new ImportJobClaimRetryError(
                                    "Import job reconciliation lost a concurrent transition",
                                );
                            }
                        }

                        const created = await transaction.importJob.create({
                            data: {
                                userId: input.userId,
                                sourceType: input.sourceType,
                                sourceId: input.sourceId,
                                sourceUrl: input.sourceUrl,
                                normalizedSource,
                                playlistName: input.playlistName,
                                requestedPlaylistName:
                                    input.requestedPlaylistName ?? null,
                                status: input.status ?? "pending",
                                progress: input.progress ?? 0,
                                summary: toImportSummaryJson(input.summary),
                                ...(input.resolvedTracks !== undefined
                                    ? {
                                          resolvedTracks: input.resolvedTracks,
                                      }
                                    : {}),
                                createdPlaylistId: null,
                                error: null,
                            },
                        });
                        return {
                            job: toStoredImportJob(
                                created as unknown as ImportJobPersistenceRecord,
                            ),
                            created: true,
                        };
                    },
                    {
                        isolationLevel:
                            Prisma.TransactionIsolationLevel.Serializable,
                    },
                );
            } catch (error) {
                const canRetry =
                    (hasPrismaErrorCode(error, "P2034") ||
                        error instanceof ImportJobClaimRetryError) &&
                    attempt < SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS;
                if (!canRetry) {
                    throw error;
                }
            }
        }

        throw new Error("Import job claim retry loop exhausted");
    }

    /**
     * Updates lifecycle state and result metadata for an existing generic import job.
     */
    async updateJob(
        jobId: string,
        input: UpdateImportJobInput,
    ): Promise<StoredImportJob> {
        const updated = await prisma.importJob.update({
            where: { id: jobId },
            data: buildJobUpdateData(input),
        });
        return toStoredImportJob(
            updated as unknown as ImportJobPersistenceRecord,
        );
    }

    /**
     * Applies a lifecycle update only when the persisted status still matches.
     */
    async transitionJob(
        jobId: string,
        expectedStatuses: readonly ImportJobLifecycleStatus[],
        input: UpdateImportJobInput,
    ): Promise<StoredImportJob | null> {
        if (expectedStatuses.length === 0) {
            return null;
        }

        return prisma.$transaction(async (transaction) => {
            const transition = await transaction.importJob.updateMany({
                where: {
                    id: jobId,
                    status: { in: [...expectedStatuses] },
                },
                data: buildJobUpdateData(input),
            });
            if (transition.count === 0) {
                return null;
            }

            const updated = await transaction.importJob.findUnique({
                where: { id: jobId },
            });
            if (!updated) {
                throw new Error("Import job disappeared during transition");
            }
            return toStoredImportJob(
                updated as unknown as ImportJobPersistenceRecord,
            );
        });
    }

    /**
     * Requests cancellation only while the owned job still has an active status.
     */
    async requestCancellation(
        jobId: string,
        userId: string,
    ): Promise<RequestImportJobCancellationResult> {
        return prisma.$transaction(async (transaction) => {
            const transition = await transaction.importJob.updateMany({
                where: {
                    id: jobId,
                    userId,
                    status: { in: ACTIVE_IMPORT_JOB_STATUSES },
                },
                data: {
                    status: "cancelling",
                    error: "Cancelled by user",
                },
            });

            if (transition.count > 0) {
                const updated = await transaction.importJob.findUnique({
                    where: { id: jobId },
                });
                if (!updated) {
                    throw new Error(
                        "Import job disappeared during cancellation",
                    );
                }
                return {
                    outcome: "updated",
                    job: toStoredImportJob(
                        updated as unknown as ImportJobPersistenceRecord,
                    ),
                };
            }

            const current = await transaction.importJob.findUnique({
                where: { id: jobId },
            });
            if (!current) {
                return { outcome: "not_found", job: null };
            }

            const stored = toStoredImportJob(
                current as unknown as ImportJobPersistenceRecord,
            );
            if (stored.userId !== userId) {
                return { outcome: "forbidden", job: null };
            }
            return { outcome: "conflict", job: stored };
        });
    }

    /**
     * Reopens a settled owned job when its visible playlist still has
     * unresolved source positions.
     */
    async requestResolutionRetry(
        jobId: string,
        userId: string,
    ): Promise<RequestImportJobRetryResult> {
        return prisma.$transaction(async (transaction) => {
            const current = await transaction.importJob.findUnique({
                where: { id: jobId },
            });
            if (!current) {
                return { outcome: "not_found", job: null };
            }
            const stored = toStoredImportJob(
                current as unknown as ImportJobPersistenceRecord,
            );
            if (stored.userId !== userId) {
                return { outcome: "forbidden", job: null };
            }
            const canRetry =
                (stored.status === "completed" ||
                    stored.status === "cancelled" ||
                    stored.status === "failed") &&
                stored.createdPlaylistId !== null &&
                Array.isArray(stored.resolvedTracks) &&
                stored.summary.unresolved > 0;
            if (!canRetry) {
                return { outcome: "conflict", job: stored };
            }

            const resolvedCount = Math.max(
                0,
                stored.summary.total - stored.summary.unresolved,
            );
            const transition = await transaction.importJob.updateMany({
                where: {
                    id: jobId,
                    userId,
                    status: { in: ["completed", "cancelled", "failed"] },
                    createdPlaylistId: { not: null },
                },
                data: {
                    status: "resolving",
                    progress: 40,
                    // A retry resumes a partially processed snapshot. Leave ETA
                    // unavailable rather than treating earlier work as if it
                    // happened instantly in this attempt.
                    resolutionStartedAt: null,
                    resolutionProcessed: resolvedCount,
                    resolutionAttempt: { increment: 1 },
                    error: null,
                },
            });
            if (transition.count === 0) {
                const winner = await transaction.importJob.findUnique({
                    where: { id: jobId },
                });
                if (!winner) {
                    return { outcome: "not_found", job: null };
                }
                return {
                    outcome: "conflict",
                    job: toStoredImportJob(
                        winner as unknown as ImportJobPersistenceRecord,
                    ),
                };
            }

            const updated = await transaction.importJob.findUnique({
                where: { id: jobId },
            });
            if (!updated) {
                throw new Error("Import job disappeared during retry");
            }
            return {
                outcome: "updated",
                job: toStoredImportJob(
                    updated as unknown as ImportJobPersistenceRecord,
                ),
            };
        });
    }

    /**
     * Retrieves a generic import job by id.
     */
    async getJob(jobId: string): Promise<StoredImportJob | null> {
        const job = await prisma.importJob.findUnique({
            where: { id: jobId },
        });
        return job
            ? toStoredImportJob(job as unknown as ImportJobPersistenceRecord)
            : null;
    }

    /**
     * Lists generic import jobs for a user, newest first.
     */
    async listJobsForUser(
        userId: string,
        limit = 25,
    ): Promise<StoredImportJob[]> {
        const jobs = await prisma.importJob.findMany({
            where: { userId },
            orderBy: { updatedAt: "desc" },
            take: limit,
        });
        return jobs.map((job) =>
            toStoredImportJob(job as unknown as ImportJobPersistenceRecord),
        );
    }

    /**
     * Finds the newest active generic import job for a normalized source and user.
     */
    async findActiveJobForSource(
        userId: string,
        normalizedSource: string,
    ): Promise<StoredImportJob | null> {
        const job = await prisma.importJob.findFirst({
            where: {
                userId,
                normalizedSource,
                status: { in: ACTIVE_IMPORT_JOB_STATUSES },
            },
            orderBy: { updatedAt: "desc" },
        });
        return job
            ? toStoredImportJob(job as unknown as ImportJobPersistenceRecord)
            : null;
    }
}

/**
 * Shared import job store singleton for universal import job persistence.
 */
export const importJobStore = new ImportJobStore();
