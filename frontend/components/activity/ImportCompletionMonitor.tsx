"use client";

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type ImportJobStatus } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { queryKeys } from "@/lib/queryKeys";

const IMPORT_JOB_POLL_INTERVAL_MS = 3000;
const IMPORT_JOB_BOOTSTRAP_MAX_RETRIES = 3;
const CANCELLED_JOB_CONFIRMATION_MAX_POLLS = 10;
const ACTIVE_IMPORT_JOB_STATUSES = new Set<ImportJobStatus>([
    "pending",
    "resolving",
    "creating_playlist",
    "cancelling",
]);

function isActiveImportJobStatus(status: ImportJobStatus): boolean {
    return ACTIVE_IMPORT_JOB_STATUSES.has(status);
}

/**
 * Keeps durable import completions connected to browser caches and playlist UI.
 */
export function ImportCompletionMonitor() {
    const { isAuthenticated, isLoading, user } = useAuth();
    const queryClient = useQueryClient();
    const queryClientRef = useRef(queryClient);
    useEffect(() => {
        queryClientRef.current = queryClient;
    }, [queryClient]);

    const enabled = isAuthenticated && !isLoading;
    const activeLifecycleRef = useRef(0);
    const nextLifecycleRef = useRef(0);
    const loadInFlightRef = useRef(false);
    const refreshPendingRef = useRef(false);
    const hasBaselineRef = useRef(false);
    const hasActiveJobsRef = useRef(false);
    const knownStatusesRef = useRef(new Map<string, ImportJobStatus>());
    const knownCreatedPlaylistIdsRef = useRef(new Map<string, string>());
    const submittedJobIdsRef = useRef(new Set<string>());
    const cancelledJobConfirmationPollsRef = useRef(new Map<string, number>());
    const shouldPollRef = useRef(false);
    const bootstrapRetryCountRef = useRef(0);
    const nextBootstrapRetryAtRef = useRef(0);

    const resetBootstrapRetry = useCallback(() => {
        bootstrapRetryCountRef.current = 0;
        nextBootstrapRetryAtRef.current = 0;
    }, []);

    const scheduleBootstrapRetry = useCallback(() => {
        if (
            bootstrapRetryCountRef.current >= IMPORT_JOB_BOOTSTRAP_MAX_RETRIES
        ) {
            shouldPollRef.current = false;
            nextBootstrapRetryAtRef.current = 0;
            return;
        }

        bootstrapRetryCountRef.current += 1;
        nextBootstrapRetryAtRef.current =
            Date.now() +
            IMPORT_JOB_POLL_INTERVAL_MS *
                2 ** (bootstrapRetryCountRef.current - 1);
        shouldPollRef.current = true;
    }, []);

    const publishCompletion = useCallback(() => {
        void queryClientRef.current.invalidateQueries({
            queryKey: queryKeys.playlists(),
        });
        void queryClientRef.current.invalidateQueries({
            queryKey: queryKeys.personalizedHomeAll(),
        });
        window.dispatchEvent(new CustomEvent("playlist-created"));
        window.dispatchEvent(new CustomEvent("notifications-changed"));
        window.dispatchEvent(new CustomEvent("import-jobs-changed"));
    }, []);

    const observeJobs = useCallback(
        (
            jobs: Awaited<ReturnType<typeof api.listImportJobs>>["jobs"],
            lifecycle: number,
        ) => {
            if (activeLifecycleRef.current !== lifecycle) return;

            const previousStatuses = knownStatusesRef.current;
            const knownCreatedPlaylistIds = knownCreatedPlaylistIdsRef.current;
            const submittedJobIds = submittedJobIdsRef.current;
            const cancelledJobConfirmationPolls =
                cancelledJobConfirmationPollsRef.current;
            const confirmationsAtStart = new Set(
                cancelledJobConfirmationPolls.keys(),
            );
            const observedJobIds = new Set<string>();
            let sawCompletion = false;
            for (const job of jobs) {
                observedJobIds.add(job.id);
                const previousStatus = previousStatuses.get(job.id);
                const wasSubmitted = submittedJobIds.has(job.id);
                const wasAwaitingCancellationConfirmation =
                    confirmationsAtStart.has(job.id);
                const completedBecameVisible =
                    job.status === "completed" &&
                    (wasSubmitted ||
                        (hasBaselineRef.current &&
                            (previousStatus === undefined ||
                                isActiveImportJobStatus(previousStatus))));
                const createdPlaylistId = job.createdPlaylistId;
                const cancelledPlaylistBecameVisible = Boolean(
                    job.status === "cancelled" &&
                    createdPlaylistId &&
                    knownCreatedPlaylistIds.get(job.id) !== createdPlaylistId &&
                    (wasSubmitted || hasBaselineRef.current),
                );
                if (completedBecameVisible || cancelledPlaylistBecameVisible) {
                    sawCompletion = true;
                }
                if (createdPlaylistId) {
                    knownCreatedPlaylistIds.set(job.id, createdPlaylistId);
                    cancelledJobConfirmationPolls.delete(job.id);
                }
                const cancellationNeedsConfirmation =
                    job.status === "cancelled" &&
                    !createdPlaylistId &&
                    !wasAwaitingCancellationConfirmation &&
                    (wasSubmitted ||
                        !hasBaselineRef.current ||
                        (hasBaselineRef.current &&
                            (previousStatus === undefined ||
                                isActiveImportJobStatus(previousStatus))));
                if (cancellationNeedsConfirmation) {
                    cancelledJobConfirmationPolls.set(
                        job.id,
                        CANCELLED_JOB_CONFIRMATION_MAX_POLLS,
                    );
                } else if (
                    wasAwaitingCancellationConfirmation &&
                    job.status === "cancelled" &&
                    !createdPlaylistId
                ) {
                    const remainingPolls =
                        cancelledJobConfirmationPolls.get(job.id) ?? 0;
                    if (remainingPolls <= 1) {
                        cancelledJobConfirmationPolls.delete(job.id);
                    } else {
                        cancelledJobConfirmationPolls.set(
                            job.id,
                            remainingPolls - 1,
                        );
                    }
                } else if (wasAwaitingCancellationConfirmation) {
                    cancelledJobConfirmationPolls.delete(job.id);
                }

                if (!isActiveImportJobStatus(job.status)) {
                    submittedJobIds.delete(job.id);
                }
            }
            for (const jobId of confirmationsAtStart) {
                if (!observedJobIds.has(jobId)) {
                    cancelledJobConfirmationPolls.delete(jobId);
                }
            }

            knownStatusesRef.current = new Map(
                jobs.map((job) => [job.id, job.status]),
            );
            hasBaselineRef.current = true;
            hasActiveJobsRef.current = jobs.some((job) =>
                isActiveImportJobStatus(job.status),
            );
            resetBootstrapRetry();
            shouldPollRef.current =
                hasActiveJobsRef.current ||
                submittedJobIds.size > 0 ||
                cancelledJobConfirmationPolls.size > 0;
            if (sawCompletion) publishCompletion();
        },
        [publishCompletion, resetBootstrapRetry],
    );

    const loadJobs = useCallback(
        async (mode: "refresh" | "poll" = "refresh") => {
            if (activeLifecycleRef.current === 0) return;
            if (!navigator.onLine) {
                if (
                    !hasActiveJobsRef.current &&
                    submittedJobIdsRef.current.size === 0 &&
                    cancelledJobConfirmationPollsRef.current.size === 0
                ) {
                    shouldPollRef.current = false;
                }
                return;
            }
            if (loadInFlightRef.current) {
                if (mode === "refresh") refreshPendingRef.current = true;
                return;
            }

            loadInFlightRef.current = true;
            try {
                let runAgain = true;
                while (runAgain && activeLifecycleRef.current !== 0) {
                    refreshPendingRef.current = false;
                    const lifecycle = activeLifecycleRef.current;
                    let data: Awaited<
                        ReturnType<typeof api.listImportJobs>
                    > | null = null;
                    try {
                        data = await api.listImportJobs();
                    } catch {
                        if (
                            activeLifecycleRef.current === lifecycle &&
                            !hasActiveJobsRef.current &&
                            submittedJobIdsRef.current.size === 0
                        ) {
                            scheduleBootstrapRetry();
                        }
                    }

                    runAgain =
                        refreshPendingRef.current &&
                        activeLifecycleRef.current !== 0;
                    if (
                        !runAgain &&
                        data &&
                        activeLifecycleRef.current === lifecycle
                    ) {
                        observeJobs(data.jobs, lifecycle);
                    }
                }
            } finally {
                loadInFlightRef.current = false;
            }
        },
        [observeJobs, scheduleBootstrapRetry],
    );

    useEffect(() => {
        const lifecycle = ++nextLifecycleRef.current;
        if (!enabled) {
            activeLifecycleRef.current = 0;
            refreshPendingRef.current = false;
            hasBaselineRef.current = false;
            hasActiveJobsRef.current = false;
            knownStatusesRef.current.clear();
            knownCreatedPlaylistIdsRef.current.clear();
            submittedJobIdsRef.current.clear();
            cancelledJobConfirmationPollsRef.current.clear();
            resetBootstrapRetry();
            shouldPollRef.current = false;
            return;
        }

        activeLifecycleRef.current = lifecycle;
        hasBaselineRef.current = false;
        hasActiveJobsRef.current = false;
        knownStatusesRef.current = new Map();
        knownCreatedPlaylistIdsRef.current = new Map();
        submittedJobIdsRef.current = new Set();
        cancelledJobConfirmationPollsRef.current = new Map();
        resetBootstrapRetry();
        shouldPollRef.current = true;
        void loadJobs();

        return () => {
            if (activeLifecycleRef.current === lifecycle) {
                activeLifecycleRef.current = 0;
                refreshPendingRef.current = false;
            }
        };
    }, [enabled, loadJobs, resetBootstrapRetry, user?.id]);

    useEffect(() => {
        const handleJobsChanged = (event: Event) => {
            const jobId = (event as CustomEvent<{ jobId?: unknown }>).detail
                ?.jobId;
            if (typeof jobId === "string" && jobId.trim().length > 0) {
                submittedJobIdsRef.current.add(jobId);
            }
            resetBootstrapRetry();
            shouldPollRef.current = true;
            void loadJobs();
        };
        const handleVisibilityChange = () => {
            if (document.visibilityState === "visible") {
                resetBootstrapRetry();
                shouldPollRef.current = true;
                void loadJobs();
            }
        };
        const handleOnline = () => {
            resetBootstrapRetry();
            shouldPollRef.current = true;
            void loadJobs();
        };
        window.addEventListener("import-jobs-changed", handleJobsChanged);
        window.addEventListener("online", handleOnline);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            window.removeEventListener(
                "import-jobs-changed",
                handleJobsChanged,
            );
            window.removeEventListener("online", handleOnline);
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
        };
    }, [loadJobs, resetBootstrapRetry]);

    useEffect(() => {
        if (!enabled) return;
        const interval = setInterval(() => {
            if (!shouldPollRef.current) return;
            if (
                !hasActiveJobsRef.current &&
                submittedJobIdsRef.current.size === 0 &&
                Date.now() < nextBootstrapRetryAtRef.current
            ) {
                return;
            }
            void loadJobs("poll");
        }, IMPORT_JOB_POLL_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [enabled, loadJobs]);

    return null;
}
