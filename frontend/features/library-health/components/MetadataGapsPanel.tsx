"use client";

import { useCallback, useState } from "react";
import {
    api,
    type LibraryHealthGapKind,
    type LibraryHealthSummary,
} from "@/lib/api";
import { gapItemLine } from "../format";
import {
    formatMetadataGapsSummaryRu,
    formatShowingRu,
    libraryOperationsRu,
} from "@/lib/i18n/libraryOperationsRu";
import { useInsightPanelLoader } from "../hooks/useInsightPanelLoader";
import { InsightPanel } from "./InsightPanel";

const GAP_TABS: Array<{ kind: LibraryHealthGapKind; label: string }> = [
    {
        kind: "missing-art",
        label: libraryOperationsRu.libraryInsights.metadata.tabs.art,
    },
    {
        kind: "missing-mbid",
        label: libraryOperationsRu.libraryInsights.metadata.tabs.mbid,
    },
    {
        kind: "missing-genres",
        label: libraryOperationsRu.libraryInsights.metadata.tabs.genres,
    },
    {
        kind: "missing-lyrics",
        label: libraryOperationsRu.libraryInsights.metadata.tabs.lyrics,
    },
];

interface MetadataGapsPanelProps {
    gaps: LibraryHealthSummary["metadataGaps"];
    refreshToken: number;
}

/** Metadata-gap counts with a tabbed drill-down into each category. */
export function MetadataGapsPanel({
    gaps,
    refreshToken,
}: Readonly<MetadataGapsPanelProps>) {
    const [activeKind, setActiveKind] =
        useState<LibraryHealthGapKind>("missing-art");
    const fetchPage = useCallback(
        () => api.getLibraryHealthGaps(activeKind, { limit: 50 }),
        [activeKind],
    );
    const page = useInsightPanelLoader(
        fetchPage,
        libraryOperationsRu.libraryInsights.metadata.loadFailed,
        refreshToken,
    );

    const totalGaps =
        gaps.missingArt.albums +
        gaps.missingMbid.albums +
        gaps.missingGenres +
        gaps.missingLyrics;

    return (
        <InsightPanel
            title={libraryOperationsRu.libraryInsights.metadata.title}
            subtitle={formatMetadataGapsSummaryRu(
                gaps.missingArt.albums,
                gaps.missingMbid.albums,
                gaps.missingGenres,
                gaps.missingLyrics,
            )}
            onFirstExpand={page.onFirstExpand}
            onRetry={page.load}
            isLoading={page.isLoading}
            error={page.error}
        >
            <div className="flex flex-wrap gap-2 mb-3">
                {GAP_TABS.map((tab) => (
                    <button
                        key={tab.kind}
                        type="button"
                        onClick={() => setActiveKind(tab.kind)}
                        className={`px-2 py-1 text-xs rounded-full border ${
                            tab.kind === activeKind
                                ? "border-brand text-white bg-white/10"
                                : "border-white/10 text-gray-400"
                        }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            {page.data && page.data.kind === activeKind ? (
                <ul className="space-y-1">
                    {page.data.items.map((item) => {
                        const line = gapItemLine(item);
                        return (
                            <li
                                key={item.id}
                                className="text-sm text-gray-300 flex justify-between gap-3"
                            >
                                <span className="truncate">{line.primary}</span>
                                <span className="text-gray-500 truncate">
                                    {line.secondary}
                                </span>
                            </li>
                        );
                    })}
                    {page.data.items.length === 0 && (
                        <li className="text-xs text-gray-500">
                            {libraryOperationsRu.libraryInsights.metadata.empty}
                        </li>
                    )}
                    {page.data.total > page.data.items.length && (
                        <li className="text-xs text-gray-500 pt-1">
                            {formatShowingRu(
                                page.data.items.length,
                                page.data.total,
                                ["запись", "записи", "записей"],
                            )}
                        </li>
                    )}
                </ul>
            ) : null}
            <p className="text-xs text-gray-500 mt-3">
                {libraryOperationsRu.libraryInsights.metadata.remediation}{" "}
                {totalGaps === 0 &&
                    libraryOperationsRu.libraryInsights.metadata.covered}
            </p>
        </InsightPanel>
    );
}
