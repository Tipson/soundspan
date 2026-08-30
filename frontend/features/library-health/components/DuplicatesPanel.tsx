"use client";

import { useCallback } from "react";
import {
    api,
    type LibraryHealthDuplicateTier,
    type LibraryHealthSummary,
} from "@/lib/api";
import { formatBytes } from "../format";
import {
    formatDuplicatesSummaryRu,
    formatShowingRu,
    formatTrackCountRu,
    libraryOperationsRu,
} from "@/lib/i18n/libraryOperationsRu";
import { useInsightPanelLoader } from "../hooks/useInsightPanelLoader";
import { InsightPanel } from "./InsightPanel";

const TIER_LABELS: Record<LibraryHealthDuplicateTier, string> = {
    audioHash: libraryOperationsRu.libraryInsights.duplicates.tiers.audioHash,
    recordingMbid:
        libraryOperationsRu.libraryInsights.duplicates.tiers.recordingMbid,
    isrc: libraryOperationsRu.libraryInsights.duplicates.tiers.isrc,
};

interface DuplicatesPanelProps {
    duplicates: LibraryHealthSummary["duplicates"];
    refreshToken: number;
}

/** Report-only duplicate/version clusters found via durable track identity. */
export function DuplicatesPanel({
    duplicates,
    refreshToken,
}: Readonly<DuplicatesPanelProps>) {
    const fetchPage = useCallback(
        () => api.getLibraryHealthDuplicates({ limit: 25 }),
        [],
    );
    const page = useInsightPanelLoader(
        fetchPage,
        libraryOperationsRu.libraryInsights.duplicates.loadFailed,
        refreshToken,
    );

    return (
        <InsightPanel
            title={libraryOperationsRu.libraryInsights.duplicates.title}
            subtitle={formatDuplicatesSummaryRu(
                duplicates.clusters,
                duplicates.byTier.audioHash,
                duplicates.byTier.recordingMbid,
                duplicates.byTier.isrc,
            )}
            isTruncated={duplicates.isTruncated}
            onFirstExpand={page.onFirstExpand}
            onRetry={page.load}
            isLoading={page.isLoading}
            error={page.error}
        >
            <p className="text-xs text-gray-500 mb-3">
                {libraryOperationsRu.libraryInsights.duplicates.reportOnly}
            </p>
            {page.data && (
                <ul className="space-y-3">
                    {page.data.clusters.map((cluster) => (
                        <li
                            key={`${cluster.tier}:${cluster.identity}`}
                            className="text-sm text-gray-300"
                        >
                            <div className="text-xs text-gray-400 mb-1">
                                {TIER_LABELS[cluster.tier]} ·{" "}
                                {formatTrackCountRu(cluster.memberCount)} ·{" "}
                                {formatBytes(cluster.totalFileSize)}
                            </div>
                            <ul className="space-y-0.5 pl-3 border-l border-white/10">
                                {cluster.members.map((member) => (
                                    <li
                                        key={member.id}
                                        className="flex justify-between gap-3"
                                    >
                                        <span className="truncate">
                                            {member.title}
                                            <span className="text-gray-500">
                                                {" "}
                                                — {member.artistName} ·{" "}
                                                {member.albumTitle}
                                            </span>
                                        </span>
                                        <span className="text-gray-500 whitespace-nowrap">
                                            {formatBytes(member.fileSize)}
                                        </span>
                                    </li>
                                ))}
                                {cluster.memberCount >
                                    cluster.members.length && (
                                    <li className="text-xs text-gray-500">
                                        {formatShowingRu(
                                            cluster.members.length,
                                            cluster.memberCount,
                                            ["трек", "трека", "треков"],
                                        )}
                                    </li>
                                )}
                            </ul>
                        </li>
                    ))}
                    {page.data.clusters.length === 0 && (
                        <li className="text-xs text-gray-500">
                            {
                                libraryOperationsRu.libraryInsights.duplicates
                                    .empty
                            }
                        </li>
                    )}
                    {page.data.total > page.data.clusters.length && (
                        <li className="text-xs text-gray-500">
                            {formatShowingRu(
                                page.data.clusters.length,
                                page.data.total,
                                ["группа", "группы", "групп"],
                            )}
                        </li>
                    )}
                </ul>
            )}
        </InsightPanel>
    );
}
