"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ImportJob } from "@/lib/api";
import {
    Loader2,
    CheckCircle2,
    XCircle,
    Ban,
    Clock,
    ArrowRight,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
    adminActivityRu,
    localizeImportJobMessage,
} from "@/lib/i18n/adminActivityRu";

const STATUS_CONFIG: Record<
    string,
    { icon: React.ElementType; color: string; label: string }
> = {
    pending: {
        icon: Clock,
        color: "text-gray-400",
        label: adminActivityRu.activity.imports.statuses.pending,
    },
    resolving: {
        icon: Loader2,
        color: "text-blue-400",
        label: adminActivityRu.activity.imports.statuses.resolving,
    },
    creating_playlist: {
        icon: Loader2,
        color: "text-blue-400",
        label: adminActivityRu.activity.imports.statuses.creating_playlist,
    },
    cancelling: {
        icon: Loader2,
        color: "text-amber-400",
        label: adminActivityRu.activity.imports.statuses.cancelling,
    },
    completed: {
        icon: CheckCircle2,
        color: "text-emerald-400",
        label: adminActivityRu.activity.imports.statuses.completed,
    },
    failed: {
        icon: XCircle,
        color: "text-red-400",
        label: adminActivityRu.activity.imports.statuses.failed,
    },
    cancelled: {
        icon: Ban,
        color: "text-gray-400",
        label: adminActivityRu.activity.imports.statuses.cancelled,
    },
};

function JobStatusBadge({ status }: { status: string }) {
    const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
    const Icon = config.icon;
    const isAnimated =
        status === "resolving" ||
        status === "creating_playlist" ||
        status === "cancelling";

    return (
        <span
            className={`flex items-center gap-1.5 text-xs font-medium ${config.color}`}
        >
            <Icon
                className={`w-3.5 h-3.5 ${isAnimated ? "animate-spin" : ""}`}
            />
            {config.label}
        </span>
    );
}

/**
 * Activity panel tab showing generic import job history and progress.
 */
export function ImportsTab() {
    const router = useRouter();
    const [jobs, setJobs] = useState<ImportJob[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
    const loadGenerationRef = useRef(0);
    const loadInFlightRef = useRef(false);
    const refreshPendingRef = useRef(false);
    const mountedRef = useRef(false);

    const loadJobs = useCallback(
        async (mode: "refresh" | "poll" = "refresh") => {
            if (!mountedRef.current) return;
            if (loadInFlightRef.current) {
                if (mode === "refresh") refreshPendingRef.current = true;
                return;
            }

            loadInFlightRef.current = true;
            let latestGeneration = loadGenerationRef.current;
            try {
                let runAgain = true;
                while (runAgain && mountedRef.current) {
                    refreshPendingRef.current = false;
                    const generation = ++loadGenerationRef.current;
                    latestGeneration = generation;
                    let data: Awaited<
                        ReturnType<typeof api.listImportJobs>
                    > | null = null;
                    try {
                        data = await api.listImportJobs();
                    } catch {
                        // Silently fail — tab is informational
                    }

                    runAgain = mountedRef.current && refreshPendingRef.current;
                    if (
                        !runAgain &&
                        data &&
                        mountedRef.current &&
                        loadGenerationRef.current === generation
                    ) {
                        setJobs(data.jobs);
                    }
                }
            } finally {
                loadInFlightRef.current = false;
                if (
                    mountedRef.current &&
                    loadGenerationRef.current === latestGeneration
                ) {
                    setIsLoading(false);
                }
            }
        },
        [],
    );

    useEffect(() => {
        mountedRef.current = true;
        void loadJobs();
        return () => {
            mountedRef.current = false;
            refreshPendingRef.current = false;
            loadGenerationRef.current += 1;
        };
    }, [loadJobs]);

    useEffect(() => {
        const handleJobsChanged = () => {
            void loadJobs();
        };
        window.addEventListener("import-jobs-changed", handleJobsChanged);
        return () =>
            window.removeEventListener(
                "import-jobs-changed",
                handleJobsChanged,
            );
    }, [loadJobs]);

    // Poll for active jobs
    useEffect(() => {
        const hasActive = jobs.some(
            (j) =>
                j.status === "pending" ||
                j.status === "resolving" ||
                j.status === "creating_playlist" ||
                j.status === "cancelling",
        );
        if (!hasActive) return;

        const interval = setInterval(() => void loadJobs("poll"), 3000);
        return () => clearInterval(interval);
    }, [jobs, loadJobs]);

    const handleCancel = async (jobId: string) => {
        try {
            await api.cancelImportJob(jobId);
            await loadJobs();
        } catch {
            // Silently fail
        }
    };

    const handleRetry = async (jobId: string) => {
        setRetryingJobId(jobId);
        try {
            await api.retryImportJob(jobId);
            await loadJobs();
        } catch {
            // The next poll keeps the durable server state authoritative.
        } finally {
            setRetryingJobId((current) => (current === jobId ? null : current));
        }
    };

    if (isLoading) {
        return (
            <div
                className="flex items-center justify-center py-12"
                role="status"
                aria-label={adminActivityRu.activity.loading}
            >
                <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
            </div>
        );
    }

    if (jobs.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                <p className="text-gray-400 text-sm">
                    {adminActivityRu.activity.imports.empty}
                </p>
                <p className="text-gray-400 text-xs mt-1">
                    {adminActivityRu.activity.imports.emptyHint}
                </p>
            </div>
        );
    }

    return (
        <div className="overflow-y-auto h-full">
            {jobs.map((job) => {
                const isActive =
                    job.status === "pending" ||
                    job.status === "resolving" ||
                    job.status === "creating_playlist" ||
                    job.status === "cancelling";
                const createdPlaylistId = job.createdPlaylistId;
                const cancellationWarning =
                    job.status === "cancelled" && createdPlaylistId
                        ? job.error
                        : null;

                return (
                    <div
                        key={job.id}
                        className="px-4 py-3 border-b border-white/5 hover:bg-white/[0.03] transition-colors"
                    >
                        <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                                <p className="text-sm text-white truncate">
                                    {job.requestedPlaylistName ||
                                        job.playlistName}
                                </p>
                                <p className="text-xs text-gray-400 truncate mt-0.5">
                                    {job.sourceType} &middot;{" "}
                                    {new Date(job.createdAt).toLocaleDateString(
                                        "ru-RU",
                                    )}
                                </p>
                            </div>
                            <JobStatusBadge status={job.status} />
                        </div>

                        {isActive && job.progress > 0 && (
                            <div className="mt-2 h-1 bg-white/5 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-blue-500 rounded-full transition-all duration-300"
                                    style={{
                                        width: `${Math.min(100, job.progress)}%`,
                                    }}
                                />
                            </div>
                        )}

                        {job.summary && job.summary.total > 0 && (
                            <p className="text-[11px] text-gray-400 mt-1">
                                {job.summary.total - job.summary.unresolved}{" "}
                                {adminActivityRu.activity.imports.ready}{" "}
                                &middot; {job.summary.unresolved}{" "}
                                {isActive
                                    ? adminActivityRu.activity.imports.searching
                                    : adminActivityRu.activity.imports
                                          .unresolved}{" "}
                                &middot; {job.summary.total}{" "}
                                {adminActivityRu.activity.imports.total}
                            </p>
                        )}

                        {isActive &&
                            job.estimatedRemainingSeconds != null &&
                            job.estimatedRemainingSeconds > 0 && (
                                <p className="text-[11px] text-gray-400 mt-1">
                                    {adminActivityRu.activity.imports.remaining}{" "}
                                    {Math.max(
                                        1,
                                        Math.ceil(
                                            job.estimatedRemainingSeconds / 60,
                                        ),
                                    )}{" "}
                                    {adminActivityRu.activity.imports.minutes}
                                </p>
                            )}

                        <div className="flex items-center gap-2 mt-2">
                            {isActive && (
                                <button
                                    onClick={() => void handleCancel(job.id)}
                                    className="text-xs text-red-400/70 hover:text-red-400 transition-colors"
                                >
                                    {adminActivityRu.activity.imports.cancel}
                                </button>
                            )}
                            {createdPlaylistId && (
                                <button
                                    onClick={() =>
                                        router.push(
                                            `/playlist/${createdPlaylistId}`,
                                        )
                                    }
                                    className="flex items-center gap-1 text-xs text-blue-400/70 hover:text-blue-400 transition-colors"
                                >
                                    {
                                        adminActivityRu.activity.imports
                                            .viewPlaylist
                                    }
                                    <ArrowRight className="w-3 h-3" />
                                </button>
                            )}
                            {(job.status === "completed" ||
                                job.status === "cancelled" ||
                                job.status === "failed") &&
                                job.summary?.unresolved > 0 && (
                                    <button
                                        onClick={() => void handleRetry(job.id)}
                                        disabled={retryingJobId === job.id}
                                        className="text-xs text-blue-400/70 hover:text-blue-400 transition-colors disabled:opacity-50"
                                    >
                                        {
                                            adminActivityRu.activity.imports
                                                .retryUnresolved
                                        }
                                    </button>
                                )}
                            {job.status === "failed" && job.error && (
                                <p className="text-xs text-red-400/60 truncate">
                                    {localizeImportJobMessage(
                                        job.error,
                                        "error",
                                    )}
                                </p>
                            )}
                        </div>
                        {cancellationWarning && (
                            <p
                                role="status"
                                className="mt-1 text-xs text-amber-300/80"
                            >
                                {adminActivityRu.activity.imports.warning}:{" "}
                                {localizeImportJobMessage(
                                    cancellationWarning,
                                    "warning",
                                )}
                            </p>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
