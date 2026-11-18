import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import {
    importJobStore,
    type StoredImportJob,
    type ImportJobSummary,
} from "./importJobStore";
import { playlistImportService } from "./playlistImportService";
import {
    IMPORT_DRAFT_CATEGORIES,
    ImportDraftError,
    parseImportDraftUpload,
    importDraftDigest,
    type ImportDraftUpload,
} from "./importDraftParser";
import {
    buildImportDraftPreview,
    readConfirmedImportDraft,
    readImportDraftData,
    type ImportDraftData,
    type ImportDraftPreview,
    type ConfirmedImportDraft,
    type ImportDraftPreviewRow,
} from "./importDraftSnapshot";
import {
    persistImportDraftEffects,
    type ImportDraftResult,
} from "./importDraftEffects";

const log = logger.child("ImportDraft");
const MAX_REVISION = 2_147_483_647;
const MUTABLE = ["draft", "previewing", "awaiting_confirmation", "failed"];
const toJson = (value: unknown): Prisma.InputJsonValue =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
type DraftRecord = NonNullable<
    Awaited<ReturnType<typeof prisma.importJob.findUnique>>
>;
type DraftTransaction = Prisma.TransactionClient;
export interface ImportDraftFence {
    version: 1;
    revision: number;
    attempt: number;
}
export interface ImportDraftRunOptions {
    retryFailures?: boolean;
    finalAttempt?: boolean;
    draftFence?: ImportDraftFence;
}
export type StoredImportDraftJob = Omit<
    StoredImportJob,
    "draftData" | "draftRevision" | "confirmedSnapshot" | "draftResult"
> & {
    draftData: ImportDraftData;
    draftRevision: number;
    confirmedSnapshot: ConfirmedImportDraft | null;
    draftResult: ImportDraftResult | null;
};
class DraftStopped extends Error {}

function revision(value: number): void {
    if (!Number.isInteger(value) || value < 1 || value >= MAX_REVISION)
        throw new ImportDraftError("import_draft_revision_conflict", 409);
}
function selectedInput(input: unknown): {
    revision: number;
    previewRevision: number;
    mappingDigest: string;
    categories: ConfirmedImportDraft["categories"];
} {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new ImportDraftError("import_selection_invalid");
    const row = input as Record<string, unknown>;
    if (
        Object.keys(row).some(
            (key) =>
                ![
                    "revision",
                    "previewRevision",
                    "mappingDigest",
                    "categories",
                ].includes(key),
        ) ||
        !Array.isArray(row.categories) ||
        row.categories.length < 1 ||
        row.categories.length > 5 ||
        new Set(row.categories).size !== row.categories.length ||
        row.categories.some(
            (category) => !IMPORT_DRAFT_CATEGORIES.includes(category),
        ) ||
        typeof row.mappingDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(row.mappingDigest)
    )
        throw new ImportDraftError("import_selection_invalid");
    revision(row.revision as number);
    revision(row.previewRevision as number);
    return {
        revision: row.revision as number,
        previewRevision: row.previewRevision as number,
        mappingDigest: row.mappingDigest,
        categories: IMPORT_DRAFT_CATEGORIES.filter((category) =>
            (row.categories as unknown[]).includes(category),
        ),
    };
}
function owned(job: DraftRecord | null, userId: string): DraftRecord {
    if (!job) throw new ImportDraftError("import_draft_not_found", 404);
    if (job.userId !== userId)
        throw new ImportDraftError("import_draft_forbidden", 403);
    if (job.draftData === null || job.draftData === undefined)
        throw new ImportDraftError("import_draft_not_found", 404);
    return job;
}
function unchanged(job: DraftRecord, expected: number): void {
    if (job.draftRevision !== expected)
        throw new ImportDraftError("import_draft_revision_conflict", 409);
}
function previewSummary(preview: ImportDraftPreview): ImportJobSummary {
    const rows = preview.rows.filter((row) => row.match !== null);
    return {
        total: rows.length,
        local: rows.filter((row) => row.match?.source === "local").length,
        youtube: rows.filter((row) => row.match?.source === "youtube").length,
        tidal: 0,
        unresolved: rows.filter((row) => row.match?.source === "unresolved")
            .length,
    };
}
async function transaction<T>(
    body: (tx: DraftTransaction) => Promise<T>,
): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await prisma.$transaction(body, {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                maxWait: 5_000,
                timeout: 20_000,
            });
        } catch (error) {
            const code =
                typeof error === "object" && error !== null && "code" in error
                    ? String(error.code)
                    : "";
            if (!["P2034", "P2002"].includes(code) || attempt === 2)
                throw error;
        }
    }
    throw new ImportDraftError("import_draft_commit_failed", 500);
}

/** Revision-bound upload operations dispatched by the existing durable import runner. */
class ImportDraftService {
    /** Store only normalized metadata; creating a draft never imports a collection. */
    async create(
        userId: string,
        input: ImportDraftUpload,
    ): Promise<StoredImportDraftJob> {
        const normalized = parseImportDraftUpload(input);
        const trackCount = normalized.entries.filter(
            (entry) =>
                entry.category !== "albums" && entry.category !== "artists",
        ).length;
        const claim = await importJobStore.claimJob({
            userId,
            sourceType: `file-${normalized.format}`,
            sourceId: normalized.sourceHash,
            sourceUrl: `file:${normalized.format}:${normalized.sourceHash}`,
            playlistName: normalized.name,
            status: "draft",
            draftData: toJson({ version: 1, normalized, preview: null }),
            draftRevision: 1,
            summary: {
                total: trackCount,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: trackCount,
            },
        });
        return this.get(userId, claim.job.id);
    }

    /** Owner-scoped DTO; raw upload bytes and arbitrary profile properties are absent. */
    async get(userId: string, jobId: string): Promise<StoredImportDraftJob> {
        const job = await importJobStore.getJob(jobId);
        if (!job) throw new ImportDraftError("import_draft_not_found", 404);
        if (job.userId !== userId)
            throw new ImportDraftError("import_draft_forbidden", 403);
        if (!job.draftData)
            throw new ImportDraftError("import_draft_not_found", 404);
        return {
            ...job,
            draftRevision: job.draftRevision ?? 0,
            draftData: readImportDraftData(job.draftData),
            confirmedSnapshot: job.confirmedSnapshot
                ? readConfirmedImportDraft(job.confirmedSnapshot)
                : null,
            draftResult: job.draftResult
                ? (job.draftResult as unknown as ImportDraftResult)
                : null,
        };
    }

    /** Editing retires all previous matching authority and cannot rewrite a confirmation. */
    async update(
        userId: string,
        jobId: string,
        expectedRevision: number,
        input: ImportDraftUpload,
    ): Promise<StoredImportDraftJob> {
        revision(expectedRevision);
        const normalized = parseImportDraftUpload(input);
        await transaction(async (tx) => {
            const job = owned(
                await tx.importJob.findUnique({ where: { id: jobId } }),
                userId,
            );
            unchanged(job, expectedRevision);
            if (job.confirmedSnapshot || !MUTABLE.includes(job.status))
                throw new ImportDraftError("import_draft_state_conflict", 409);
            const changed = await tx.importJob.updateMany({
                where: {
                    id: jobId,
                    userId,
                    draftRevision: expectedRevision,
                    status: { in: MUTABLE },
                },
                data: {
                    draftRevision: { increment: 1 },
                    resolutionAttempt: { increment: 1 },
                    draftData: toJson({
                        version: 1,
                        normalized,
                        preview: null,
                    }),
                    sourceId: normalized.sourceHash,
                    sourceUrl: `file:${normalized.format}:${normalized.sourceHash}`,
                    sourceType: `file-${normalized.format}`,
                    normalizedSource: `file-${normalized.format}:${normalized.sourceHash}`,
                    playlistName: normalized.name,
                    status: "draft",
                    progress: 0,
                    error: null,
                },
            });
            if (changed.count !== 1)
                throw new ImportDraftError(
                    "import_draft_revision_conflict",
                    409,
                );
        });
        return this.get(userId, jobId);
    }

    /** Start one explicitly requested matching revision; recovery uses the same journal. */
    async requestPreview(
        userId: string,
        jobId: string,
        expectedRevision: number,
    ): Promise<StoredImportDraftJob> {
        revision(expectedRevision);
        await transaction(async (tx) => {
            const job = owned(
                await tx.importJob.findUnique({ where: { id: jobId } }),
                userId,
            );
            unchanged(job, expectedRevision);
            if (
                job.confirmedSnapshot ||
                !MUTABLE.includes(job.status) ||
                job.resolutionAttempt >= MAX_REVISION - 1
            )
                throw new ImportDraftError("import_draft_state_conflict", 409);
            if (job.status === "previewing") return;
            const data = readImportDraftData(job.draftData);
            await tx.importJob.updateMany({
                where: {
                    id: jobId,
                    userId,
                    draftRevision: expectedRevision,
                    status: job.status,
                },
                data: {
                    status: "previewing",
                    resolutionAttempt: { increment: 1 },
                    progress: 20,
                    draftData: toJson({ ...data, preview: null }),
                    error: null,
                },
            });
        });
        return this.get(userId, jobId);
    }

    /** Freeze selected categories and the exact server-stored preview, once. */
    async confirm(
        userId: string,
        jobId: string,
        input: unknown,
    ): Promise<StoredImportDraftJob> {
        const selected = selectedInput(input);
        await transaction(async (tx) => {
            const job = owned(
                await tx.importJob.findUnique({ where: { id: jobId } }),
                userId,
            );
            unchanged(job, selected.revision);
            if (job.confirmedSnapshot) {
                const previous = readConfirmedImportDraft(
                    job.confirmedSnapshot,
                );
                if (
                    previous.previewRevision !== selected.previewRevision ||
                    previous.mappingDigest !== selected.mappingDigest ||
                    JSON.stringify(previous.categories) !==
                        JSON.stringify(selected.categories) ||
                    job.status === "cancelled" ||
                    job.status === "cancelling"
                )
                    throw new ImportDraftError(
                        "import_draft_revision_conflict",
                        409,
                    );
                if (job.status === "failed")
                    await tx.importJob.updateMany({
                        where: {
                            id: jobId,
                            userId,
                            status: "failed",
                            draftRevision: selected.revision,
                        },
                        data: {
                            status: "pending",
                            resolutionAttempt: { increment: 1 },
                            error: null,
                        },
                    });
                return;
            }
            const data = readImportDraftData(job.draftData),
                preview = data.preview;
            if (
                job.status !== "awaiting_confirmation" ||
                !preview ||
                preview.revision !== selected.revision ||
                preview.previewRevision !== selected.previewRevision ||
                preview.mappingDigest !== selected.mappingDigest
            )
                throw new ImportDraftError(
                    "import_draft_revision_conflict",
                    409,
                );
            if (
                !data.normalized.entries.some((entry) =>
                    selected.categories.includes(entry.category),
                ) &&
                !(
                    selected.categories.includes("playlists") &&
                    data.normalized.groups.length
                )
            )
                throw new ImportDraftError("import_selection_empty");
            const snapshot: ConfirmedImportDraft = {
                version: 1,
                ...selected,
                sourceHash: data.normalized.sourceHash,
                confirmedAt: Date.now(),
                normalized: data.normalized,
                preview,
            };
            readConfirmedImportDraft(snapshot);
            const changed = await tx.importJob.updateMany({
                where: {
                    id: jobId,
                    userId,
                    status: "awaiting_confirmation",
                    draftRevision: selected.revision,
                    resolutionAttempt: job.resolutionAttempt,
                },
                data: {
                    status: "pending",
                    progress: 0,
                    resolutionAttempt: { increment: 1 },
                    confirmedSnapshot: toJson(snapshot),
                    error: null,
                },
            });
            if (changed.count !== 1)
                throw new ImportDraftError(
                    "import_draft_revision_conflict",
                    409,
                );
        });
        return this.get(userId, jobId);
    }

    /** Execute only the captured draft generation, using the existing Bull worker. */
    async runJob(
        jobId: string,
        options: ImportDraftRunOptions = {},
    ): Promise<void> {
        const job = await prisma.importJob.findUnique({ where: { id: jobId } });
        if (!job || !job.draftData) return;
        const expected = options.draftFence;
        if (
            expected &&
            (expected.version !== 1 ||
                expected.revision !== job.draftRevision ||
                expected.attempt !== job.resolutionAttempt)
        )
            return;
        if (job.status === "cancelling") {
            await this.finishCancellation(job);
            return;
        }
        if (job.status === "completed") {
            await this.flushPostCommit(job.id);
            return;
        }
        if (
            !["previewing", "pending", "creating_playlist"].includes(job.status)
        )
            return;
        try {
            if (job.status === "previewing") await this.resolvePreview(job);
            else await this.commit(job);
        } catch (error) {
            if (error instanceof DraftStopped) return;
            if (options.retryFailures && options.finalAttempt === false)
                throw new ImportDraftError("import_draft_execution_retry", 503);
            await prisma.importJob.updateMany({
                where: {
                    id: jobId,
                    userId: job.userId,
                    draftRevision: job.draftRevision,
                    resolutionAttempt: job.resolutionAttempt,
                    status: {
                        in: ["previewing", "pending", "creating_playlist"],
                    },
                },
                data: {
                    status: "failed",
                    progress: 100,
                    error:
                        error instanceof ImportDraftError
                            ? error.code
                            : "import_draft_failed",
                },
            });
        }
    }

    /** Terminal queue delivery may never fail a later revision or repeat effects. */
    async finalizeQueueFailure(
        jobId: string,
        expected?: ImportDraftFence,
    ): Promise<void> {
        const job = await prisma.importJob.findUnique({ where: { id: jobId } });
        if (
            !job?.draftData ||
            (expected &&
                (job.draftRevision !== expected.revision ||
                    job.resolutionAttempt !== expected.attempt))
        )
            return;
        if (job.status === "completed") {
            await this.flushPostCommit(jobId);
            return;
        }
        if (job.status === "cancelling") {
            await this.finishCancellation(job);
            return;
        }
        await prisma.importJob.updateMany({
            where: {
                id: jobId,
                userId: job.userId,
                draftRevision: job.draftRevision,
                resolutionAttempt: job.resolutionAttempt,
                status: { in: ["previewing", "pending", "creating_playlist"] },
            },
            data: {
                status: "failed",
                error: "import_draft_queue_failed",
                progress: 100,
            },
        });
    }

    /** Replay only committed private cache invalidation, never collection effects. */
    async recoverPostCommit(): Promise<number> {
        const jobs = await prisma.importJob.findMany({
            where: {
                status: "completed",
                draftResult: { path: ["invalidationPending"], equals: true },
            },
            select: { id: true },
            orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            take: 100,
        });
        for (const job of jobs) await this.flushPostCommit(job.id);
        return jobs.length;
    }
    private async flushPostCommit(jobId: string): Promise<void> {
        const job = await prisma.importJob.findUnique({ where: { id: jobId } });
        if (
            !job?.draftData ||
            job.status !== "completed" ||
            !job.draftResult ||
            typeof job.draftResult !== "object" ||
            Array.isArray(job.draftResult) ||
            job.draftResult.invalidationPending !== true
        )
            return;
        try {
            const client =
                typeof redisClient.withAbortSignal === "function"
                    ? redisClient.withAbortSignal(AbortSignal.timeout(3_000))
                    : redisClient;
            await client.del(`mixes:${job.userId}`);
            await prisma.importJob.updateMany({
                where: {
                    id: jobId,
                    userId: job.userId,
                    status: "completed",
                    draftRevision: job.draftRevision,
                    draftResult: {
                        path: ["invalidationPending"],
                        equals: true,
                    },
                },
                data: {
                    draftResult: toJson({
                        ...job.draftResult,
                        invalidationPending: false,
                    }),
                },
            });
        } catch {
            log.warn("Import draft private invalidation remains pending", {
                jobId,
            });
        }
    }
    private async finishCancellation(job: DraftRecord): Promise<void> {
        await prisma.importJob.updateMany({
            where: {
                id: job.id,
                userId: job.userId,
                status: "cancelling",
                draftRevision: job.draftRevision,
                resolutionAttempt: job.resolutionAttempt,
            },
            data: {
                status: "cancelled",
                progress: 100,
                error: "import_cancelled",
            },
        });
    }
    private async resolvePreview(job: DraftRecord): Promise<void> {
        const data = readImportDraftData(job.draftData);
        const tracks = data.normalized.entries.filter(
            (entry) =>
                entry.category !== "albums" && entry.category !== "artists",
        );
        const check = async () => {
            const current = await prisma.importJob.findUnique({
                where: { id: job.id },
            });
            if (
                !current ||
                current.status !== "previewing" ||
                current.userId !== job.userId ||
                current.draftRevision !== job.draftRevision ||
                current.resolutionAttempt !== job.resolutionAttempt
            )
                throw new DraftStopped();
        };
        const matches = await playlistImportService.matchDraftTracks(tracks, {
            check,
        });
        if (matches.length !== tracks.length)
            throw new ImportDraftError("import_match_invalid", 502);
        const byEntry = new Map(
            tracks.map((entry, index) => [entry.id, matches[index]]),
        );
        const rows: ImportDraftPreviewRow[] = data.normalized.entries.map(
            (entry) => {
                const match = byEntry.get(entry.id) ?? null;
                const exact = entry.sourceRef;
                const negativeId =
                    exact?.source === "youtube"
                        ? `yt:${exact.entityId}`
                        : exact?.source === "library" &&
                            match?.source === "local" &&
                            match.trackId === exact.entityId
                          ? exact.entityId
                          : null;
                const reason =
                    entry.category === "dislikes" && !negativeId
                        ? "exact_negative_unavailable"
                        : match?.source === "unresolved"
                          ? (entry.unresolvedReason ?? "match_unavailable")
                          : match === null && !exact
                            ? "missing_source_identity"
                            : null;
                return {
                    entryId: entry.id,
                    match,
                    confidence: match?.confidence ?? (exact ? 100 : 0),
                    negativeId,
                    unresolvedReason: reason,
                };
            },
        );
        const preview = buildImportDraftPreview(
            data.normalized,
            job.draftRevision,
            job.resolutionAttempt,
            rows,
        );
        await prisma.importJob.updateMany({
            where: {
                id: job.id,
                userId: job.userId,
                draftRevision: job.draftRevision,
                resolutionAttempt: job.resolutionAttempt,
                status: "previewing",
            },
            data: {
                draftData: toJson({ ...data, preview }),
                status: "awaiting_confirmation",
                summary: toJson(previewSummary(preview)),
                progress: 100,
                error: null,
            },
        });
    }
    private async commit(initial: DraftRecord): Promise<void> {
        await transaction(async (tx) => {
            const claimed = await tx.importJob.updateMany({
                where: {
                    id: initial.id,
                    userId: initial.userId,
                    draftRevision: initial.draftRevision,
                    resolutionAttempt: initial.resolutionAttempt,
                    status: { in: ["pending", "creating_playlist"] },
                },
                data: { status: "creating_playlist" },
            });
            if (claimed.count !== 1) return;
            const job = owned(
                await tx.importJob.findUnique({ where: { id: initial.id } }),
                initial.userId,
            );
            const snapshot = readConfirmedImportDraft(job.confirmedSnapshot),
                draft = readImportDraftData(job.draftData);
            if (
                snapshot.revision !== job.draftRevision ||
                snapshot.sourceHash !== draft.normalized.sourceHash ||
                snapshot.mappingDigest !== draft.preview?.mappingDigest
            )
                throw new ImportDraftError(
                    "import_draft_snapshot_invalid",
                    409,
                );
            const result = await persistImportDraftEffects(
                tx,
                job.userId,
                job.id,
                snapshot,
            );
            const completed = await tx.importJob.updateMany({
                where: {
                    id: job.id,
                    userId: job.userId,
                    status: "creating_playlist",
                    draftRevision: job.draftRevision,
                    resolutionAttempt: job.resolutionAttempt,
                },
                data: {
                    status: "completed",
                    progress: 100,
                    createdPlaylistId: result.playlistIds[0] ?? null,
                    draftResult: toJson(result),
                    error: null,
                },
            });
            if (completed.count !== 1)
                throw new ImportDraftError("import_draft_state_conflict", 409);
        });
        await this.flushPostCommit(initial.id);
    }
}

/** Shared draft extension; execution and delivery remain on GenericImportJobRunner. */
export const importDraftService = new ImportDraftService();
