import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { genericImportQueue } from "../workers/queues";
import {
    importJobStore,
    type ImportJobLifecycleStatus,
    type StoredImportJob,
    type UpdateImportJobInput,
} from "./importJobStore";
import { GENERIC_IMPORT_COMMIT_RECONCILIATION_WARNING } from "./genericImportIdentity";
import {
    playlistImportService,
    type PlaylistImportProgressEvent,
} from "./playlistImportService";
import { SpotifyPlaylistPaginationError } from "./spotifyPlaylistPagination";
import { backgroundPlaylistImport } from "./backgroundPlaylistImport";

const log = logger.child("GenericImportJobRunner");
const RUN_JOB_NAME = "generic-import-run";
const RECOVERY_JOB_NAME = "generic-import-recover";
const RECOVERY_BATCH_SIZE = 100;
const RECOVERY_INTERVAL_MS = 60_000;
const SAFE_FAILURE_MESSAGE = "Generic import job failed";
const ACTIVE_IMPORT_JOB_STATUSES = [
    "pending",
    "resolving",
    "creating_playlist",
    "cancelling",
] as const;
const PROCESSING_IMPORT_JOB_STATUSES = [
    "pending",
    "resolving",
    "creating_playlist",
] as const;
const CANCELLATION_COMPLETION_WARNING =
    "Cancellation requested after playlist creation completed";

function safeFailureMessage(error: unknown): string {
    if (error instanceof SpotifyPlaylistPaginationError) {
        return error.codeOwnedMessage();
    }
    return SAFE_FAILURE_MESSAGE;
}

function responseStatus(error: unknown): number | null {
    const seen = new Set<unknown>();
    let candidate: unknown = error;
    for (let depth = 0; depth < 5 && candidate !== null; depth += 1) {
        if (seen.has(candidate)) return null;
        seen.add(candidate);
        if (typeof candidate !== "object") return null;
        const response = (candidate as { response?: unknown }).response;
        if (typeof response === "object" && response !== null) {
            const status = (response as { status?: unknown }).status;
            if (typeof status === "number") return status;
        }
        candidate = (candidate as { cause?: unknown }).cause ?? null;
    }
    return null;
}

function isNonRetryableImportFailure(error: unknown): boolean {
    return (
        (error instanceof SpotifyPlaylistPaginationError &&
            !error.providerFailure) ||
        responseStatus(error) === 429
    );
}

function persistedProgressFor(event: PlaylistImportProgressEvent): number {
    const fraction =
        event.total > 0
            ? Math.max(0, Math.min(1, event.completed / event.total))
            : 1;
    switch (event.stage) {
        case "source":
            return 25;
        case "local":
            return 30;
        case "tidal":
            return 30 + Math.round(10 * fraction);
        case "youtube":
            return 40 + Math.round(28 * fraction);
    }
}

type ImportPreview = Awaited<
    ReturnType<typeof playlistImportService.previewImport>
>;
type ImportExecution = Awaited<
    ReturnType<typeof playlistImportService.importPlaylist>
>;
type ImportResolvedTrack = ImportPreview["resolved"][number];

const IMPORT_SNAPSHOT_SOURCES = new Set([
    "local",
    "youtube",
    "tidal",
    "unresolved",
]);

interface RunJobOptions {
    retryFailures?: boolean;
    finalAttempt?: boolean;
}

class ImportJobCancelledError extends Error {}
class ImportJobTerminalError extends Error {}
class ImportJobSupersededError extends Error {}

function isTerminalStatus(status: string): boolean {
    return (
        status === "completed" || status === "failed" || status === "cancelled"
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
    return value === undefined || typeof value === "string";
}

function isOptionalFiniteNumber(value: unknown): boolean {
    return (
        value === undefined ||
        (typeof value === "number" && Number.isFinite(value) && value >= 0)
    );
}

function parseResolvedTrackSnapshot(
    value: unknown,
): ImportResolvedTrack | null {
    if (!isRecord(value)) return null;
    if (
        typeof value.index !== "number" ||
        !Number.isInteger(value.index) ||
        value.index < 0
    ) {
        return null;
    }
    if (typeof value.artist !== "string" || typeof value.title !== "string") {
        return null;
    }
    if (
        typeof value.source !== "string" ||
        !IMPORT_SNAPSHOT_SOURCES.has(value.source)
    ) {
        return null;
    }
    if (
        typeof value.confidence !== "number" ||
        !Number.isFinite(value.confidence) ||
        value.confidence < 0 ||
        value.confidence > 100
    ) {
        return null;
    }
    if (
        !isOptionalString(value.album) ||
        !isOptionalFiniteNumber(value.duration) ||
        !isOptionalString(value.isrc) ||
        !isOptionalString(value.videoId) ||
        !isOptionalFiniteNumber(value.tidalId) ||
        !isOptionalString(value.trackId) ||
        !isOptionalString(value.trackTidalId) ||
        !isOptionalString(value.trackYtMusicId)
    ) {
        return null;
    }

    const providerIdentities = [
        ["local", value.trackId],
        ["tidal", value.trackTidalId],
        ["youtube", value.trackYtMusicId],
    ] as const;
    const presentIdentities: Array<
        readonly ["local" | "tidal" | "youtube", string]
    > = [];
    for (const [provider, identity] of providerIdentities) {
        if (typeof identity === "string") {
            presentIdentities.push([provider, identity]);
        }
    }
    if (
        presentIdentities.some(
            ([, identity]) =>
                identity.length === 0 || identity.trim() !== identity,
        )
    ) {
        return null;
    }
    if (value.source === "unresolved") {
        if (presentIdentities.length !== 0) return null;
    } else if (
        presentIdentities.length !== 1 ||
        presentIdentities[0]?.[0] !== value.source
    ) {
        return null;
    }

    return {
        index: value.index,
        artist: value.artist,
        title: value.title,
        source: value.source as ImportResolvedTrack["source"],
        confidence: value.confidence,
        ...(typeof value.album === "string" ? { album: value.album } : {}),
        ...(typeof value.duration === "number"
            ? { duration: value.duration }
            : {}),
        ...(typeof value.isrc === "string" ? { isrc: value.isrc } : {}),
        ...(typeof value.videoId === "string"
            ? { videoId: value.videoId }
            : {}),
        ...(typeof value.tidalId === "number"
            ? { tidalId: value.tidalId }
            : {}),
        ...(typeof value.trackId === "string"
            ? { trackId: value.trackId }
            : {}),
        ...(typeof value.trackTidalId === "string"
            ? { trackTidalId: value.trackTidalId }
            : {}),
        ...(typeof value.trackYtMusicId === "string"
            ? { trackYtMusicId: value.trackYtMusicId }
            : {}),
    };
}

function summarizeResolvedTracks(
    resolvedTracks: ImportResolvedTrack[],
): ImportPreview["summary"] {
    return {
        total: resolvedTracks.length,
        local: resolvedTracks.filter((track) => track.source === "local")
            .length,
        youtube: resolvedTracks.filter((track) => track.source === "youtube")
            .length,
        tidal: resolvedTracks.filter((track) => track.source === "tidal")
            .length,
        unresolved: resolvedTracks.filter(
            (track) => track.source === "unresolved",
        ).length,
    };
}

function processedTracksFor(
    event: PlaylistImportProgressEvent,
    total: number,
): number {
    if (event.stage !== "youtube") return 0;
    const completedBeforeYouTube = Math.max(0, total - event.total);
    return Math.min(total, completedBeforeYouTube + event.completed);
}

function isImportSummarySnapshot(
    value: unknown,
): value is ImportPreview["summary"] {
    if (!isRecord(value)) return false;
    return ["total", "local", "youtube", "tidal", "unresolved"].every(
        (field) =>
            Number.isInteger(value[field]) && (value[field] as number) >= 0,
    );
}

function restoreImportPreview(job: StoredImportJob): ImportPreview {
    if (!Array.isArray(job.resolvedTracks)) {
        throw new Error("Persisted import snapshot is missing resolved tracks");
    }
    const parsedTracks = job.resolvedTracks.map(parseResolvedTrackSnapshot);
    if (parsedTracks.some((track) => track === null)) {
        throw new Error("Persisted import snapshot contains invalid tracks");
    }
    const resolvedTracks = parsedTracks.filter(
        (track): track is ImportResolvedTrack => track !== null,
    );
    if (resolvedTracks.some((track, position) => track.index !== position)) {
        throw new Error(
            "Persisted import snapshot positions are not contiguous and ordered",
        );
    }
    if (!isImportSummarySnapshot(job.summary)) {
        throw new Error(
            "Persisted import snapshot contains an invalid summary",
        );
    }
    if (!job.playlistName.trim()) {
        throw new Error("Persisted import snapshot is missing a playlist name");
    }

    const localCount = resolvedTracks.filter(
        (track) => track.source === "local",
    ).length;
    const youtubeCount = resolvedTracks.filter(
        (track) => track.source === "youtube",
    ).length;
    const tidalCount = resolvedTracks.filter(
        (track) => track.source === "tidal",
    ).length;
    const unresolvedCount = resolvedTracks.filter(
        (track) => track.source === "unresolved",
    ).length;
    if (
        job.summary.total !== resolvedTracks.length ||
        job.summary.local !== localCount ||
        job.summary.youtube !== youtubeCount ||
        job.summary.tidal !== tidalCount ||
        job.summary.unresolved !== unresolvedCount
    ) {
        throw new Error("Persisted import snapshot counts are inconsistent");
    }

    return {
        playlistName: job.playlistName,
        resolved: resolvedTracks,
        summary: job.summary,
    };
}

/**
 * Queue-backed execution runner for persisted generic import jobs.
 */
export class GenericImportJobRunner {
    /**
     * Supervises durable queue insertion for an API-created import job.
     */
    enqueue(jobId: string, resolutionAttempt = 0): void {
        void this.enqueuePersistedJob(jobId, resolutionAttempt).catch(
            (error) => {
                log.error("Failed to enqueue persisted import job", {
                    jobId,
                    error,
                });
            },
        );
    }

    /**
     * Registers startup and periodic recovery sweeps in the durable queue.
     */
    async registerRecoveryJobs(): Promise<void> {
        await genericImportQueue.isReady();
        const startupRegistration = genericImportQueue.add(
            RECOVERY_JOB_NAME,
            { trigger: "startup" },
            {
                jobId: "generic-import-recovery:startup",
                removeOnComplete: true,
                removeOnFail: true,
            },
        );
        const repeatRegistration = genericImportQueue.add(
            RECOVERY_JOB_NAME,
            { trigger: "repeat" },
            {
                jobId: "generic-import-recovery:repeat",
                repeat: { every: RECOVERY_INTERVAL_MS },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
        await Promise.all([startupRegistration, repeatRegistration]);
    }

    /**
     * Requeues one bounded batch of persisted active jobs after delivery gaps or restarts.
     */
    async recoverActiveJobs(): Promise<number> {
        const jobs = await prisma.importJob.findMany({
            where: { status: { in: [...ACTIVE_IMPORT_JOB_STATUSES] } },
            orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            select: { id: true, resolutionAttempt: true },
            take: RECOVERY_BATCH_SIZE,
        });

        let recoveredCount = 0;
        for (
            let index = 0;
            index < jobs.length && index < RECOVERY_BATCH_SIZE;
            index += 1
        ) {
            const job = jobs[index];
            if (job) {
                await this.enqueuePersistedJob(job.id, job.resolutionAttempt);
                recoveredCount += 1;
            }
        }

        if (recoveredCount > 0) {
            log.info("Recovered persisted import jobs", {
                count: recoveredCount,
            });
        }
        return recoveredCount;
    }

    /**
     * Executes an import job and exposes failures to Bull while retries remain.
     */
    async runJob(jobId: string, options: RunJobOptions = {}): Promise<void> {
        try {
            await this.executeJob(jobId);
        } catch (error) {
            if (error instanceof ImportJobCancelledError) {
                await this.finishCancellation(jobId);
                return;
            }
            if (
                error instanceof ImportJobTerminalError ||
                error instanceof ImportJobSupersededError
            ) {
                return;
            }

            const shouldRethrow = await this.handleExecutionFailure(
                jobId,
                error,
                options,
            );
            if (options.retryFailures && shouldRethrow) {
                throw error;
            }
        }
    }

    /**
     * Marks a persisted job failed when Bull exhausts lease or processor recovery.
     */
    async finalizeQueueFailure(jobId: string, error: unknown): Promise<void> {
        if (await this.reconcileCommittedPlaylist(jobId)) {
            log.warn("Reconciled committed import after queue failure", {
                jobId,
                error,
            });
            return;
        }
        const failed = await this.persistSafeFailure(jobId, error);
        if (!failed) {
            await this.finishCancellationIfRequested(jobId);
            return;
        }

        log.error("Import queue exhausted recovery", { jobId, error });
    }

    private async enqueuePersistedJob(
        jobId: string,
        resolutionAttempt = 0,
    ): Promise<void> {
        if (!jobId.trim()) {
            throw new Error("Generic import job id is required");
        }
        const queueJobId =
            resolutionAttempt > 1
                ? `${jobId}:resolution:${resolutionAttempt}`
                : jobId;
        const existingJob = await genericImportQueue.getJob(queueJobId);
        if (existingJob) {
            const state = await existingJob.getState();
            if (state === "failed" || state === "completed") {
                await this.finalizeQueueFailure(
                    jobId,
                    new Error(`Queue job is terminal in state ${state}`),
                );
            }
            return;
        }
        await genericImportQueue.add(
            RUN_JOB_NAME,
            { jobId },
            { jobId: queueJobId },
        );
    }

    private async executeJob(jobId: string): Promise<void> {
        const initialJob = await importJobStore.getJob(jobId);
        if (!initialJob || isTerminalStatus(initialJob.status)) {
            return;
        }

        let runnableJob = await this.ensureRunnable(jobId);
        let preview: ImportPreview | undefined;
        if (runnableJob.status !== "creating_playlist") {
            const resolved = await this.resolvePreview(jobId);
            runnableJob = resolved.job;
            preview = resolved.preview;
        }
        if (
            runnableJob.status !== "creating_playlist" &&
            runnableJob.createdPlaylistId &&
            preview
        ) {
            const visiblePlaylistId = runnableJob.createdPlaylistId;
            runnableJob = await this.transitionOrStop(jobId, ["resolving"], {
                status: "creating_playlist",
                progress: 99,
                playlistName:
                    runnableJob.requestedPlaylistName ?? preview.playlistName,
                summary: preview.summary,
                resolvedTracks:
                    preview.resolved as unknown as Prisma.InputJsonValue,
                resolutionProcessed: preview.summary.total,
            });
            await this.completeJob(jobId, {
                playlistId: visiblePlaylistId,
                summary: preview.summary,
            });
            return;
        }
        const execution = await this.createPlaylist(
            jobId,
            runnableJob,
            preview,
        );
        await this.completeJob(jobId, execution);
    }

    private async resolvePreview(
        jobId: string,
    ): Promise<{ job: StoredImportJob; preview: ImportPreview }> {
        const job = await this.transitionOrStop(
            jobId,
            ["pending", "resolving"],
            {
                status: "resolving",
                progress: 20,
            },
        );
        let persistedProgress = Math.max(20, job.progress ?? 0);
        let resolutionProcessed = job.resolutionProcessed ?? 0;
        let resolutionAttempt = job.resolutionAttempt ?? 0;
        let visiblePlaylistId = job.createdPlaylistId;
        let snapshot: ImportResolvedTrack[] = [];
        let currentSummary = job.summary;
        if (visiblePlaylistId && job.resolvedTracks) {
            const restored = restoreImportPreview(job);
            snapshot = restored.resolved;
            currentSummary = restored.summary;
        }
        let progressWrites = Promise.resolve();
        const persistBackgroundState = (
            newlyResolved: ImportResolvedTrack[],
        ) => {
            if (!visiblePlaylistId) return progressWrites;
            const playlistId = visiblePlaylistId;
            const persistedSnapshot = snapshot.map((track) => ({ ...track }));
            const persistedSummary = { ...currentSummary };
            const progress = persistedProgress;
            const processed = resolutionProcessed;
            progressWrites = progressWrites.then(async () => {
                const persisted =
                    await backgroundPlaylistImport.persistResolution({
                        jobId,
                        userId: job.userId,
                        playlistId,
                        expectedResolutionAttempt: resolutionAttempt,
                        newlyResolved,
                        snapshot: persistedSnapshot,
                        summary: persistedSummary,
                        progress,
                        resolutionProcessed: processed,
                    });
                if (!persisted) {
                    const latestJob = await importJobStore.getJob(jobId);
                    if (latestJob?.status === "cancelling") {
                        throw new ImportJobCancelledError();
                    }
                    throw new ImportJobSupersededError();
                }
            });
            return progressWrites;
        };
        const onPrepared = async (prepared: ImportPreview) => {
            const playlistName =
                job.requestedPlaylistName ?? prepared.playlistName;
            const initialized = await backgroundPlaylistImport.initialize({
                jobId,
                userId: job.userId,
                playlistName,
                tracks: prepared.resolved,
            });
            visiblePlaylistId = initialized.playlistId;
            resolutionAttempt = initialized.resolutionAttempt;
            snapshot = prepared.resolved.map((track) => ({ ...track }));
            currentSummary = { ...prepared.summary };
            persistedProgress = 25;
            resolutionProcessed = 0;
        };
        const onResolved = async (tracks: ImportResolvedTrack[]) => {
            const byIndex = new Map(
                tracks.map((track) => [track.index, track] as const),
            );
            snapshot = snapshot.map((track) =>
                byIndex.has(track.index)
                    ? { ...(byIndex.get(track.index) as ImportResolvedTrack) }
                    : track,
            );
            currentSummary = summarizeResolvedTracks(snapshot);
            await persistBackgroundState(tracks);
        };
        const onProgress = (event: PlaylistImportProgressEvent) => {
            const nextProgress = persistedProgressFor(event);
            const nextProcessed = processedTracksFor(
                event,
                currentSummary.total,
            );
            if (
                nextProgress <= persistedProgress &&
                nextProcessed <= resolutionProcessed
            ) {
                return progressWrites;
            }
            persistedProgress = Math.max(persistedProgress, nextProgress);
            resolutionProcessed = Math.max(resolutionProcessed, nextProcessed);
            if (visiblePlaylistId) {
                return persistBackgroundState([]);
            }
            progressWrites = progressWrites.then(async () => {
                await this.transitionOrStop(jobId, ["resolving"], {
                    progress: persistedProgress,
                });
            });
            return progressWrites;
        };
        const preview = visiblePlaylistId
            ? await playlistImportService.resolvePreparedImport(
                  job.userId,
                  {
                      playlistName: job.playlistName,
                      resolved: snapshot,
                      summary: currentSummary,
                  },
                  { onProgress, onResolved },
              )
            : await playlistImportService.previewImport(
                  job.userId,
                  job.sourceUrl,
                  { onPrepared, onProgress, onResolved },
              );
        await progressWrites;
        return {
            job: {
                ...job,
                status: "resolving",
                progress: persistedProgress,
                playlistName: job.requestedPlaylistName ?? preview.playlistName,
                summary: preview.summary,
                resolvedTracks: preview.resolved as unknown as Prisma.JsonValue,
                createdPlaylistId: visiblePlaylistId,
                resolutionProcessed,
            },
            preview,
        };
    }

    private async createPlaylist(
        jobId: string,
        job: StoredImportJob,
        preview: ImportPreview | undefined,
    ): Promise<ImportExecution> {
        if (job.status !== "creating_playlist") {
            if (!preview) {
                throw new Error("Resolved import preview is missing");
            }
            await importJobStore.transitionJob(jobId, ["resolving"], {
                status: "creating_playlist",
                progress: 70,
                playlistName: job.requestedPlaylistName ?? preview.playlistName,
                summary: preview.summary,
                resolvedTracks:
                    preview.resolved as unknown as Prisma.InputJsonValue,
            });
        }

        // This same-state CAS is both a cancellation fence and the authoritative
        // snapshot read. A concurrent preview winner is allowed to persist the
        // resolving -> creating_playlist transition exactly once; every worker
        // imports only the snapshot returned here.
        const creatingJob = await this.transitionOrStop(
            jobId,
            ["creating_playlist"],
            {
                status: "creating_playlist",
            },
        );
        const persistedPreview = restoreImportPreview(creatingJob);
        return playlistImportService.importPlaylist(
            creatingJob.userId,
            persistedPreview,
            creatingJob.requestedPlaylistName ?? undefined,
            { idempotencyKey: jobId },
        );
    }

    private async completeJob(
        jobId: string,
        execution: ImportExecution,
    ): Promise<boolean> {
        const completion = {
            status: "completed",
            progress: 100,
            summary: execution.summary,
            createdPlaylistId: execution.playlistId,
            error: null,
        } as const;
        const completed = await importJobStore.transitionJob(
            jobId,
            ["creating_playlist"],
            completion,
        );
        if (completed) {
            return true;
        }

        const completedAfterCancellation = await importJobStore.transitionJob(
            jobId,
            ["cancelling"],
            {
                ...completion,
                error: CANCELLATION_COMPLETION_WARNING,
            },
        );
        if (completedAfterCancellation) {
            return true;
        }

        const completedAfterFailure = await importJobStore.transitionJob(
            jobId,
            ["failed"],
            {
                ...completion,
                error: GENERIC_IMPORT_COMMIT_RECONCILIATION_WARNING,
            },
        );
        if (completedAfterFailure) {
            return true;
        }

        const latestJob = await importJobStore.getJob(jobId);
        if (latestJob?.status === "cancelled") {
            const cancelled = await importJobStore.transitionJob(
                jobId,
                ["cancelled"],
                {
                    progress: 100,
                    summary: execution.summary,
                    createdPlaylistId: execution.playlistId,
                    error: CANCELLATION_COMPLETION_WARNING,
                },
            );
            if (cancelled) {
                return true;
            }
        }
        return latestJob?.status === "completed";
    }

    private async handleExecutionFailure(
        jobId: string,
        error: unknown,
        options: RunJobOptions,
    ): Promise<boolean> {
        if (await this.reconcileCommittedPlaylist(jobId)) {
            log.warn("Reconciled committed import after execution failure", {
                jobId,
                error,
            });
            return false;
        }
        const nonRetryable = isNonRetryableImportFailure(error);
        if (
            options.retryFailures &&
            options.finalAttempt === false &&
            !nonRetryable
        ) {
            const latestJob = await importJobStore.getJob(jobId);
            if (this.isCancellationStatus(latestJob?.status)) {
                await this.finishCancellation(jobId);
                return false;
            }
            if (!latestJob || isTerminalStatus(latestJob.status)) {
                return false;
            }
            log.warn("Import job attempt failed; queue retry remains", {
                jobId,
                error,
            });
            return true;
        }

        const failed = await this.persistSafeFailure(jobId, error);
        if (!failed) {
            await this.finishCancellationIfRequested(jobId);
        }
        log.error("Import job failed", { jobId, error });
        return nonRetryable ? false : failed;
    }

    private async reconcileCommittedPlaylist(jobId: string): Promise<boolean> {
        const job = await importJobStore.getJob(jobId);
        if (!job) {
            return false;
        }
        const playlistId = await playlistImportService.findImportedPlaylistId(
            job.userId,
            jobId,
        );
        if (!playlistId) {
            return false;
        }
        return this.completeJob(jobId, {
            playlistId,
            summary: job.summary,
        });
    }

    private async persistSafeFailure(
        jobId: string,
        error?: unknown,
    ): Promise<boolean> {
        const failed = await importJobStore.transitionJob(
            jobId,
            PROCESSING_IMPORT_JOB_STATUSES,
            {
                status: "failed",
                progress: 100,
                error: safeFailureMessage(error),
            },
        );
        return failed !== null;
    }

    private async finishCancellation(jobId: string): Promise<void> {
        await importJobStore.transitionJob(jobId, ["cancelling"], {
            status: "cancelled",
            progress: 100,
            error: "Cancelled by user",
        });
    }

    private async finishCancellationIfRequested(jobId: string): Promise<void> {
        const latestJob = await importJobStore.getJob(jobId);
        if (this.isCancellationStatus(latestJob?.status)) {
            await this.finishCancellation(jobId);
        }
    }

    private async ensureRunnable(jobId: string): Promise<StoredImportJob> {
        const job = await importJobStore.getJob(jobId);
        if (!job) {
            throw new ImportJobTerminalError("Import job no longer exists");
        }
        if (this.isCancellationStatus(job.status)) {
            throw new ImportJobCancelledError("Import job is cancelled");
        }
        if (isTerminalStatus(job.status)) {
            throw new ImportJobTerminalError("Import job is already terminal");
        }
        return job;
    }

    private async transitionOrStop(
        jobId: string,
        expectedStatuses: readonly ImportJobLifecycleStatus[],
        input: UpdateImportJobInput,
    ): Promise<StoredImportJob> {
        const transitioned = await importJobStore.transitionJob(
            jobId,
            expectedStatuses,
            input,
        );
        if (transitioned) {
            return transitioned;
        }

        const latestJob = await importJobStore.getJob(jobId);
        if (!latestJob) {
            throw new ImportJobTerminalError("Import job no longer exists");
        }
        if (this.isCancellationStatus(latestJob.status)) {
            throw new ImportJobCancelledError("Import job is cancelled");
        }
        if (isTerminalStatus(latestJob.status)) {
            throw new ImportJobTerminalError("Import job is already terminal");
        }
        throw new ImportJobSupersededError(
            `Import job advanced to ${latestJob.status}`,
        );
    }

    private isCancellationStatus(status: string | undefined): boolean {
        return status === "cancelling" || status === "cancelled";
    }
}

/** Shared queue-backed runner used by import routes and workers. */
export const genericImportJobRunner = new GenericImportJobRunner();
