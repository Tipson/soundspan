import { Music, Download, CheckCircle } from "lucide-react";
import { cn } from "@/utils/cn";
import { SoulseekResult } from "../types";
import { SearchSectionHeader } from "./SearchSectionHeader";

interface SoulseekSongsListProps {
    soulseekResults: SoulseekResult[];
    downloadingFiles: Set<string>;
    onDownload: (result: SoulseekResult) => void;
}

// Helper function to get quality badge
/**
 * Implements getQualityBadge.
 */
export const getQualityBadge = (result: SoulseekResult) => {
    if (result.format === "flac") {
        return (
            <span className="px-2 py-1 text-xs font-semibold bg-ai-dark/20 text-ai-hover rounded">
                FLAC
            </span>
        );
    }
    if (result.bitrate >= 320) {
        return (
            <span className="px-2 py-1 text-xs font-semibold bg-green-600/20 text-green-400 rounded">
                320 kbps
            </span>
        );
    }
    if (result.bitrate >= 256) {
        return (
            <span className="px-2 py-1 text-xs font-semibold bg-blue-600/20 text-blue-400 rounded">
                256 kbps
            </span>
        );
    }
    return (
        <span className="px-2 py-1 text-xs font-semibold bg-gray-600/20 text-gray-400 rounded">
            {result.bitrate} kbps
        </span>
    );
};

// Helper function to parse filename
export const parseFilename = (
    filename: string,
): { artist: string; title: string } => {
    const match = filename.match(/([^/\\]+)\.(?:mp3|flac|m4a|wav)$/i);
    if (match) {
        const nameWithoutExt = match[1];
        const parts = nameWithoutExt.split(" - ");
        if (parts.length >= 2) {
            return {
                artist: parts[0].trim(),
                title: parts.slice(1).join(" - ").trim(),
            };
        }
        return { artist: "Unknown", title: nameWithoutExt };
    }
    return { artist: "Unknown", title: filename };
};

/**
 * Renders the SoulseekSongsList component.
 */
export function SoulseekSongsList({
    soulseekResults,
    downloadingFiles,
    onDownload,
}: SoulseekSongsListProps) {
    if (soulseekResults.length === 0) {
        return null;
    }

    return (
        <div>
            <SearchSectionHeader
                title="Downloadable matches"
                description="No instant stream matched, so these files are available to save"
            />
            <div className="space-y-1.5" data-tv-section="search-results-songs">
                {soulseekResults.slice(0, 5).map((result, index) => {
                    const parsed = result.parsedArtist
                        ? {
                              artist: result.parsedArtist,
                              title:
                                  result.filename
                                      .split("\\")
                                      .pop()
                                      ?.split(" - ")
                                      .slice(1)
                                      .join(" - ") || result.filename,
                          }
                        : parseFilename(result.filename);

                    const isDownloading = downloadingFiles.has(result.filename);

                    return (
                        <div
                            key={`${result.username}-${result.filename}-${index}`}
                            className="group flex min-h-14 items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 transition-colors hover:border-white/[0.06] hover:bg-white/[0.045] sm:gap-4 sm:px-3"
                        >
                            <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-surface-elevated">
                                <Music className="h-5 w-5 text-content-muted" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <h4 className="truncate text-sm font-semibold text-content sm:text-base">
                                    {parsed.title}
                                </h4>
                                <p className="truncate text-xs text-content-secondary sm:text-sm">
                                    {parsed.artist}
                                </p>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                                {getQualityBadge(result)}
                                <button
                                    data-tv-card
                                    data-tv-card-index={index}
                                    tabIndex={0}
                                    onClick={() => onDownload(result)}
                                    disabled={isDownloading}
                                    className={cn(
                                        "flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                                        isDownloading
                                            ? "bg-green-600/20 text-green-400 cursor-not-allowed"
                                            : "bg-brand text-black hover:bg-brand-dark hover:scale-[1.02] motion-reduce:hover:scale-100",
                                    )}
                                >
                                    {isDownloading ? (
                                        <>
                                            <CheckCircle className="w-4 h-4" />
                                            Downloading
                                        </>
                                    ) : (
                                        <>
                                            <Download className="w-4 h-4" />
                                            Download
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
