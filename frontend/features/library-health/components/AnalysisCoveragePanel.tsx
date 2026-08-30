"use client";

import { useCallback, useState } from "react";
import { api, type LibraryHealthSummary } from "@/lib/api";
import { enrichmentApi } from "@/lib/enrichmentApi";
import {
    formatAnalysisCoverageSummaryRu,
    formatShowingRu,
    libraryOperationsRu,
} from "@/lib/i18n/libraryOperationsRu";
import { formatCoveragePercent } from "../format";
import { useInsightPanelLoader } from "../hooks/useInsightPanelLoader";
import { InsightPanel } from "./InsightPanel";

interface AnalysisCoveragePanelProps {
    coverage: LibraryHealthSummary["analysisCoverage"];
    refreshToken: number;
    /** Called after a retry action changes backend state; refreshes the section counts. */
    onRemediated?: () => void;
}

/** Analysis, vibe, and loudness coverage with retry actions for failures. */
export function AnalysisCoveragePanel({
    coverage,
    refreshToken,
    onRemediated,
}: Readonly<AnalysisCoveragePanelProps>) {
    const fetchPage = useCallback(
        () => api.getLibraryHealthAnalysis({ limit: 50 }),
        [],
    );
    const page = useInsightPanelLoader(
        fetchPage,
        libraryOperationsRu.libraryInsights.analysis.loadFailed,
        refreshToken,
    );
    const [actionNotice, setActionNotice] = useState<string | null>(null);
    const [isActing, setIsActing] = useState(false);

    const runAction = (action: () => Promise<unknown>, done: string) => {
        setIsActing(true);
        setActionNotice(null);
        void action()
            .then(() => {
                setActionNotice(done);
                if (onRemediated) {
                    onRemediated();
                } else {
                    page.load();
                }
            })
            .catch(() => {
                setActionNotice(
                    libraryOperationsRu.libraryInsights.analysis.actionFailed,
                );
            })
            .finally(() => {
                setIsActing(false);
            });
    };

    const analysisDone = coverage.analysisStatus.completed;
    const vibeDone = coverage.vibeAnalysisStatus.completed;
    const loudnessTotal =
        coverage.loudness.measured + coverage.loudness.missing;

    return (
        <InsightPanel
            title={libraryOperationsRu.libraryInsights.analysis.title}
            subtitle={formatAnalysisCoverageSummaryRu(
                formatCoveragePercent(analysisDone, coverage.total),
                formatCoveragePercent(vibeDone, coverage.total),
                formatCoveragePercent(
                    coverage.loudness.measured,
                    loudnessTotal,
                ),
                coverage.analysisStatus.failed,
            )}
            onFirstExpand={page.onFirstExpand}
            onRetry={page.load}
            isLoading={page.isLoading}
            error={page.error}
        >
            <div className="flex flex-wrap gap-2 mb-3">
                <button
                    type="button"
                    disabled={isActing}
                    onClick={() =>
                        runAction(
                            () => api.retryFailedAnalysis(),
                            libraryOperationsRu.libraryInsights.analysis
                                .audioQueued,
                        )
                    }
                    className="px-2 py-1 text-xs rounded-full border border-white/10 text-gray-300 disabled:opacity-50"
                >
                    {libraryOperationsRu.libraryInsights.analysis.retryAudio}
                </button>
                <button
                    type="button"
                    disabled={isActing}
                    onClick={() =>
                        runAction(
                            () => enrichmentApi.retryVibeEmbeddings(),
                            libraryOperationsRu.libraryInsights.analysis
                                .vibeQueued,
                        )
                    }
                    className="px-2 py-1 text-xs rounded-full border border-white/10 text-gray-300 disabled:opacity-50"
                >
                    {libraryOperationsRu.libraryInsights.analysis.retryVibe}
                </button>
            </div>
            {actionNotice && (
                <p className="text-xs text-gray-400 mb-2">{actionNotice}</p>
            )}
            {page.data && page.data.failed.items.length > 0 && (
                <ul className="space-y-1">
                    {page.data.failed.items.map((track) => (
                        <li key={track.id} className="text-sm text-gray-300">
                            <span className="truncate">{track.title}</span>
                            <span className="text-gray-500">
                                {" "}
                                — {track.artistName}
                                {track.analysisError
                                    ? ` · ${libraryOperationsRu.libraryInsights.analysis.itemError}`
                                    : ""}
                            </span>
                        </li>
                    ))}
                    {page.data.failed.total > page.data.failed.items.length && (
                        <li className="text-xs text-gray-500 pt-1">
                            {formatShowingRu(
                                page.data.failed.items.length,
                                page.data.failed.total,
                                ["трек", "трека", "треков"],
                            )}
                        </li>
                    )}
                </ul>
            )}
            {page.data && page.data.failed.items.length === 0 && (
                <p className="text-xs text-gray-500">
                    {libraryOperationsRu.libraryInsights.analysis.empty}
                </p>
            )}
        </InsightPanel>
    );
}
