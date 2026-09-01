"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { dispatchQueryEvent } from "@/lib/query-events";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { syncRu } from "@/lib/i18n/utilityPagesRu";
import { AlertTriangle, Check, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";

/**
 * Renders the SyncPage component.
 */
export default function SyncPage() {
    const [syncing, setSyncing] = useState(true);
    const [progress, setProgress] = useState(0);
    const [message, setMessage] = useState<string>(syncRu.scanningLibrary);
    const [error, setError] = useState("");
    const [completedSteps, setCompletedSteps] = useState<string[]>([]);

    useEffect(() => {
        let mounted = true;
        let pollInterval: NodeJS.Timeout | null = null;
        let redirectTimeout: NodeJS.Timeout | null = null;

        const startSync = async () => {
            try {
                // Start the library scan
                const scanResult = await api.scanLibrary();
                const jobId = scanResult.jobId;

                if (!mounted) return;
                setMessage(syncRu.scanningLibrary);

                // Poll for actual scan progress
                pollInterval = setInterval(async () => {
                    try {
                        const status = await api.getScanStatus(jobId);

                        if (!mounted) {
                            if (pollInterval) clearInterval(pollInterval);
                            return;
                        }

                        if (status.status === "completed") {
                            if (pollInterval) clearInterval(pollInterval);
                            setProgress(90);
                            setCompletedSteps([
                                "tracks",
                                "library",
                                "albums",
                                "indexes",
                            ]);

                            // Trigger post-scan operations
                            try {
                                // 1. Audiobook sync
                                setMessage(syncRu.syncingAudiobooks);
                                await api.post("/audiobooks/sync");
                            } catch (audiobookError) {
                                sharedFrontendLogger.error(
                                    "Audiobook sync failed:",
                                    audiobookError,
                                );
                                // Don't fail the whole flow if audiobook sync fails
                            }

                            if (!mounted) return;
                            setProgress(95);

                            // Enrichment runs on-demand from Settings page
                            // Artists get images from Deezer/Fanart when first viewed

                            // Dispatch event to update Recently Added section
                            dispatchQueryEvent("library-updated");

                            setProgress(100);
                            setMessage(syncRu.redirecting);
                            redirectTimeout = setTimeout(() => {
                                // Use window.location for full page reload to ensure fresh data
                                window.location.href = "/";
                            }, 1500);
                        } else if (status.status === "failed") {
                            if (pollInterval) clearInterval(pollInterval);
                            setError(syncRu.scanFailed);
                            setSyncing(false);
                        } else {
                            // Update progress based on actual scan progress
                            setProgress(Math.min(status.progress || 0, 90)); // Cap at 90% to reserve last 10% for audiobooks

                            // Update completed steps based on progress
                            const steps: string[] = [];
                            if (status.progress >= 15) steps.push("tracks");
                            if (status.progress >= 30) steps.push("library");
                            if (status.progress >= 50) steps.push("albums");
                            if (status.progress >= 70) steps.push("indexes");
                            setCompletedSteps(steps);

                            if (status.progress > 0 && status.progress < 30) {
                                setMessage(syncRu.discoveringTracks);
                            } else if (
                                status.progress >= 30 &&
                                status.progress < 60
                            ) {
                                setMessage(syncRu.indexingAlbums);
                            } else if (
                                status.progress >= 60 &&
                                status.progress < 90
                            ) {
                                setMessage(syncRu.organizingArtists);
                            } else if (status.progress >= 90) {
                                setMessage(syncRu.almostDone);
                            }
                        }
                    } catch (pollError) {
                        sharedFrontendLogger.error(
                            "Error polling scan status:",
                            pollError,
                        );
                    }
                }, 1000); // Poll every second
            } catch (err: unknown) {
                sharedFrontendLogger.error("Sync error:", err);
                if (!mounted) return;
                setError(syncRu.startFailed);
                setSyncing(false);
            }
        };

        startSync();

        return () => {
            mounted = false;
            if (pollInterval) {
                clearInterval(pollInterval);
            }
            if (redirectTimeout) {
                clearTimeout(redirectTimeout);
            }
        };
    }, []);

    const handleSkip = () => {
        // Use window.location for full page reload to ensure fresh data
        window.location.href = "/";
    };

    const steps = [
        { id: "tracks", label: syncRu.stepTracks },
        { id: "library", label: syncRu.stepLibrary },
        { id: "albums", label: syncRu.stepAlbums },
        { id: "indexes", label: syncRu.stepIndexes },
    ];

    return (
        <main
            data-utility-page="sync"
            className="min-h-screen px-4 py-6 md:px-8"
        >
            <div className="mx-auto w-full max-w-4xl">
                <PageHeader
                    title="Синхронизация коллекции"
                    subtitle={syncRu.largeLibraryHint}
                    icon={RefreshCw}
                />

                <section className="overflow-hidden rounded-3xl border border-line bg-surface-elevated shadow-2xl shadow-black/10">
                    <div
                        className="h-px bg-gradient-to-r from-transparent via-brand/70 to-transparent"
                        aria-hidden="true"
                    />
                    <div className="space-y-7 p-5 sm:p-8">
                        <div
                            className="flex flex-col gap-4 sm:flex-row sm:items-center"
                            aria-live="polite"
                        >
                            <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-brand/10 text-brand">
                                {error ? (
                                    <AlertTriangle
                                        className="size-6"
                                        aria-hidden="true"
                                    />
                                ) : (
                                    <RefreshCw
                                        className="size-6 animate-spin motion-reduce:animate-none"
                                        aria-hidden="true"
                                    />
                                )}
                            </span>
                            <div className="min-w-0">
                                <h2 className="text-xl font-semibold text-content">
                                    {error
                                        ? "Синхронизация приостановлена"
                                        : progress === 100
                                          ? syncRu.ready
                                          : syncRu.settingUp}
                                </h2>
                                <p className="mt-1 text-sm leading-6 text-content-muted">
                                    {error || message}
                                </p>
                            </div>
                        </div>

                        {syncing && !error && (
                            <div className="space-y-3">
                                <div
                                    role="progressbar"
                                    aria-label="Прогресс синхронизации коллекции"
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={progress}
                                    className="h-2.5 w-full overflow-hidden rounded-full bg-surface-active"
                                >
                                    <div
                                        className="h-full rounded-full bg-brand transition-[width] duration-500 ease-out motion-reduce:transition-none"
                                        style={{ width: `${progress}%` }}
                                    />
                                </div>
                                <p className="text-sm font-medium tabular-nums text-content-muted">
                                    {progress}% {syncRu.complete}
                                </p>
                            </div>
                        )}

                        {error && (
                            <div
                                role="alert"
                                className="rounded-2xl border border-error/25 bg-error/5 p-4 text-sm leading-6 text-error"
                            >
                                {error}
                            </div>
                        )}

                        <div className="grid grid-cols-1 gap-3 border-t border-line pt-6 sm:grid-cols-2">
                            {steps.map((step) => {
                                const isComplete = completedSteps.includes(
                                    step.id,
                                );
                                return (
                                    <div
                                        key={step.id}
                                        className="flex min-h-11 items-center gap-3 rounded-xl bg-surface px-3 text-sm"
                                    >
                                        <span
                                            className={
                                                isComplete
                                                    ? "flex size-6 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"
                                                    : "size-6 shrink-0 rounded-full border border-line-muted bg-surface-elevated"
                                            }
                                            aria-hidden="true"
                                        >
                                            {isComplete && (
                                                <Check className="size-3.5" />
                                            )}
                                        </span>
                                        <span
                                            className={
                                                isComplete
                                                    ? "font-medium text-content"
                                                    : "text-content-muted"
                                            }
                                        >
                                            {step.label}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>

                        <div className="flex justify-stretch border-t border-line pt-5 sm:justify-end">
                            <Button
                                variant="ghost"
                                onClick={handleSkip}
                                className="w-full sm:w-auto"
                            >
                                {syncRu.skip}
                            </Button>
                        </div>
                    </div>
                </section>
            </div>
        </main>
    );
}
