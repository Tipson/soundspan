"use client";

import { useCallback } from "react";
import { api, type LibraryHealthSummary } from "@/lib/api";
import { formatBytes, formatKbps } from "../format";
import {
    formatStorageSummaryRu,
    libraryOperationsRu,
} from "@/lib/i18n/libraryOperationsRu";
import { useInsightPanelLoader } from "../hooks/useInsightPanelLoader";
import { InsightPanel } from "./InsightPanel";

interface StoragePanelProps {
    storage: LibraryHealthSummary["storage"];
    refreshToken: number;
}

/** Storage breakdown by format plus the artists using the most space. */
export function StoragePanel({
    storage,
    refreshToken,
}: Readonly<StoragePanelProps>) {
    const fetchReport = useCallback(() => api.getLibraryHealthStorage(), []);
    const report = useInsightPanelLoader(
        fetchReport,
        libraryOperationsRu.libraryInsights.storage.loadFailed,
        refreshToken,
    );

    return (
        <InsightPanel
            title={libraryOperationsRu.libraryInsights.storage.title}
            subtitle={formatStorageSummaryRu(
                storage.tracks,
                formatBytes(storage.totalFileSize),
                storage.mimeTypes,
            )}
            isTruncated={storage.isTruncated}
            onFirstExpand={report.onFirstExpand}
            onRetry={report.load}
            isLoading={report.isLoading}
            error={report.error}
        >
            {report.data && (
                <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                        <h3 className="text-xs font-medium text-gray-400 mb-1">
                            {
                                libraryOperationsRu.libraryInsights.storage
                                    .byFormat
                            }
                        </h3>
                        <ul className="space-y-1">
                            {report.data.formats.map((format) => (
                                <li
                                    key={format.mime ?? "unknown"}
                                    className="text-sm text-gray-300 flex justify-between gap-3"
                                >
                                    <span className="truncate">
                                        {format.mime ??
                                            libraryOperationsRu.libraryInsights
                                                .storage.unknownFormat}
                                    </span>
                                    <span className="text-gray-500 whitespace-nowrap">
                                        {format.trackCount} ·{" "}
                                        {formatBytes(format.totalFileSize)} · ~
                                        {formatKbps(format.averageBitrateKbps)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                    <div>
                        <h3 className="text-xs font-medium text-gray-400 mb-1">
                            {
                                libraryOperationsRu.libraryInsights.storage
                                    .largestArtists
                            }
                        </h3>
                        <ul className="space-y-1">
                            {report.data.topArtists.map((artist) => (
                                <li
                                    key={artist.artistId}
                                    className="text-sm text-gray-300 flex justify-between gap-3"
                                >
                                    <span className="truncate">
                                        {artist.artistName}
                                    </span>
                                    <span className="text-gray-500 whitespace-nowrap">
                                        {artist.trackCount} ·{" "}
                                        {formatBytes(artist.totalFileSize)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            )}
        </InsightPanel>
    );
}
