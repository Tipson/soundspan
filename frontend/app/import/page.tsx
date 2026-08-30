"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, FileUp, Link, Loader2, Music4 } from "lucide-react";
import {
    api,
    type ImportResolutionSource,
    type PlaylistImportExecuteResponse,
    type PlaylistImportPreviewResponse,
    type PlaylistImportResolvedTrack,
} from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { ru, userFacingError } from "@/lib/i18n/ru";
import {
    formatImportResolutionSubtitle,
    formatImportSkipped,
    formatImportSongsFound,
    importPageRu,
} from "@/lib/i18n/utilityPagesRu";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { formatTime } from "@/utils/formatTime";
import { queryKeys } from "@/lib/queryKeys";

type ImportStep = "input" | "preview" | "executing" | "complete";
type ImportMode = "url" | "file";

function tryParsePlaylistUrl(rawInput: string): URL | null {
    const trimmed = rawInput.trim();
    if (!trimmed) return null;

    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;
    try {
        const parsed = new URL(withProtocol);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function getResolutionSubtitle(track: PlaylistImportResolvedTrack): string {
    return formatImportResolutionSubtitle(track);
}

/**
 * Executes isSupportedPlaylistUrl.
 */
export function isSupportedPlaylistUrl(url: string): boolean {
    const parsed = tryParsePlaylistUrl(url);
    if (!parsed) return false;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    const path = parsed.pathname;

    if (hostname === "open.spotify.com") {
        return /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?playlist\/[a-zA-Z0-9]+\/?$/i.test(
            path,
        );
    }

    if (hostname === "deezer.com" || hostname.endsWith(".deezer.com")) {
        return /^\/(?:[a-z]{2}\/)?playlist\/\d+\/?$/i.test(path);
    }

    if (
        hostname === "youtube.com" ||
        hostname === "www.youtube.com" ||
        hostname === "music.youtube.com"
    ) {
        return path === "/playlist" && parsed.searchParams.has("list");
    }

    if (hostname === "tidal.com" || hostname === "listen.tidal.com") {
        return /^\/(?:browse\/)?playlist\/[a-zA-Z0-9-]+\/?$/i.test(path);
    }

    return false;
}

/**
 * Executes executeImportAction.
 */
export async function executeImportAction(options: {
    previewData: PlaylistImportPreviewResponse;
    name?: string;
}): Promise<PlaylistImportExecuteResponse> {
    const name = options.name?.trim();
    return api.executePlaylistImport({
        previewData: options.previewData,
        ...(name ? { name } : {}),
    });
}

/**
 * Renders the ImportResolutionBadge component.
 */
export function ImportResolutionBadge({
    source,
}: {
    source: ImportResolutionSource;
}) {
    if (source === "local") {
        return (
            <span
                className="shrink-0 text-[10px] font-bold bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded"
                title={importPageRu.localBadge}
            >
                {importPageRu.localBadge}
            </span>
        );
    }

    if (source === "youtube") {
        return <YouTubeBadge />;
    }

    if (source === "tidal") {
        return <TidalBadge />;
    }

    return (
        <span
            className="shrink-0 text-[10px] font-bold bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded"
            title={importPageRu.unresolvedBadge}
        >
            {importPageRu.unresolvedBadge}
        </span>
    );
}

/**
 * Renders the PreviewTrackResolutionList component.
 */
export function PreviewTrackResolutionList({
    tracks,
}: {
    tracks: PlaylistImportResolvedTrack[];
}) {
    if (tracks.length === 0) {
        return (
            <div className="p-4 text-sm text-gray-400">
                {importPageRu.noTracks}
            </div>
        );
    }

    return (
        <div className="max-h-96 overflow-y-auto divide-y divide-white/5">
            {tracks.map((track, idx) => (
                <div
                    key={`${track.index}-${track.artist}-${track.title}-${idx}`}
                    className="px-4 py-3 hover:bg-white/5"
                >
                    <div className="flex items-start gap-3">
                        <span className="text-xs text-gray-400 w-6 text-right pt-0.5">
                            {idx + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm text-white truncate">
                                {track.title}
                            </div>
                            <div className="text-xs text-gray-400 truncate">
                                {track.artist}
                                {track.album ? ` • ${track.album}` : ""}
                            </div>
                            <div className="text-[11px] text-gray-400 mt-1">
                                {getResolutionSubtitle(track)}
                            </div>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                            <ImportResolutionBadge source={track.source} />
                            {typeof track.duration === "number" &&
                                track.duration > 0 && (
                                    <span className="text-[11px] text-gray-400">
                                        {formatTime(track.duration)}
                                    </span>
                                )}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}

function ImportPageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const hasAutoSubmitted = useRef(false);
    const jobSubmissionInFlightRef = useRef(false);

    const [step, setStep] = useState<ImportStep>("input");
    const [importMode, setImportMode] = useState<ImportMode>("url");
    const [urlInput, setUrlInput] = useState("");
    const [playlistName, setPlaylistName] = useState("");
    const [preview, setPreview] =
        useState<PlaylistImportPreviewResponse | null>(null);
    const [result, setResult] = useState<PlaylistImportExecuteResponse | null>(
        null,
    );
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);
    const [isJobSubmitting, setIsJobSubmitting] = useState(false);
    const [isExecuting, setIsExecuting] = useState(false);
    const [m3uFileName, setM3uFileName] = useState("");
    const [m3uContent, setM3uContent] = useState("");
    const [m3uPlaylistName, setM3uPlaylistName] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleM3uFileSelect = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = () => {
                const content = reader.result as string;
                setM3uContent(content);
                setM3uFileName(file.name);
                const defaultName = file.name
                    .replace(/\.(m3u8?|M3U8?)$/, "")
                    .replace(/[_-]/g, " ");
                setM3uPlaylistName(defaultName);
            };
            reader.onerror = () => {
                toast.error(importPageRu.fileReadFailed);
            };
            reader.readAsText(file);
        },
        [toast],
    );

    const fetchM3uPreview = useCallback(async () => {
        if (!m3uContent) {
            toast.error(importPageRu.selectM3uFirst);
            return;
        }

        setIsPreviewLoading(true);
        try {
            const response = await api.previewM3UImport(
                m3uContent,
                m3uPlaylistName || undefined,
            );
            setPreview(response);
            setPlaylistName(response.playlistName);
            setStep("preview");
        } catch (error) {
            toast.error(userFacingError(error, importPageRu.previewM3uFailed));
        } finally {
            setIsPreviewLoading(false);
        }
    }, [m3uContent, m3uPlaylistName, toast]);

    const handleExecute = async () => {
        if (!preview) return;

        setIsExecuting(true);
        setStep("executing");
        try {
            const executeResult = await executeImportAction({
                previewData: preview,
                name: playlistName,
            });
            void queryClient.invalidateQueries({
                queryKey: queryKeys.personalizedHomeAll(),
            });
            setResult(executeResult);
            setStep("complete");
            window.dispatchEvent(new CustomEvent("notifications-changed"));
            window.dispatchEvent(new CustomEvent("playlist-created"));
        } catch (error) {
            setStep("preview");
            toast.error(userFacingError(error, importPageRu.importFailed));
        } finally {
            setIsExecuting(false);
        }
    };

    const handleSubmitBackgroundJob = useCallback(
        async (nextUrl: string) => {
            if (jobSubmissionInFlightRef.current) {
                return;
            }
            const parsedUrl = tryParsePlaylistUrl(nextUrl);
            if (!parsedUrl || !isSupportedPlaylistUrl(parsedUrl.href)) {
                toast.error(importPageRu.supportedUrls);
                return;
            }
            const nextCanonicalUrl = parsedUrl.href;
            jobSubmissionInFlightRef.current = true;
            setUrlInput(nextCanonicalUrl);
            setIsJobSubmitting(true);

            try {
                const result = await api.submitImportJob(nextCanonicalUrl);
                if (result.deduped) {
                    toast.info(importPageRu.alreadyInProgress);
                } else {
                    toast.success(importPageRu.jobSubmitted);
                }
                window.dispatchEvent(
                    new CustomEvent("import-jobs-changed", {
                        detail: { jobId: result.job.id },
                    }),
                );
                setUrlInput("");
            } catch (error) {
                toast.error(userFacingError(error, importPageRu.submitFailed));
            } finally {
                jobSubmissionInFlightRef.current = false;
                setIsJobSubmitting(false);
            }
        },
        [toast],
    );

    useEffect(() => {
        const urlParam = searchParams.get("url");
        if (!urlParam || hasAutoSubmitted.current) {
            return;
        }

        const timeoutId = window.setTimeout(() => {
            if (hasAutoSubmitted.current) return;
            hasAutoSubmitted.current = true;
            void handleSubmitBackgroundJob(urlParam);
        }, 0);
        return () => window.clearTimeout(timeoutId);
    }, [handleSubmitBackgroundJob, searchParams]);

    const returnToInput = () => {
        setStep("input");
        setPlaylistName("");
        setPreview(null);
        setResult(null);
    };

    const resetFlow = () => {
        setStep("input");
        setUrlInput("");
        setPlaylistName("");
        setPreview(null);
        setResult(null);
        setIsJobSubmitting(false);
        setIsExecuting(false);
        setM3uContent("");
        setM3uFileName("");
        setM3uPlaylistName("");
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const importableCount = preview
        ? preview.summary.total - preview.summary.unresolved
        : 0;

    const completedImportableCount = result
        ? result.summary.total - result.summary.unresolved
        : 0;
    return (
        <div className="min-h-screen relative">
            <div className="absolute inset-0 pointer-events-none">
                <div
                    className="absolute inset-0 bg-linear-to-b from-brand/15 via-blue-900/10 to-transparent"
                    style={{ height: "35vh" }}
                />
                <div
                    className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] from-brand/8 via-transparent to-transparent"
                    style={{ height: "25vh" }}
                />
            </div>

            <div className="relative max-w-3xl mx-auto px-6 py-6">
                <div className="flex items-center gap-4 mb-6">
                    <button
                        aria-label={importPageRu.back}
                        onClick={() => router.back()}
                        className="p-2 hover:bg-white/5 rounded-full transition-colors"
                    >
                        <ArrowLeft className="w-5 h-5 text-gray-400" />
                    </button>
                    <div>
                        <h1 className="text-2xl font-bold text-white">
                            {ru.import.playlistTitle}
                        </h1>
                        <p className="text-sm text-gray-400">
                            {ru.import.servicesOrFile}
                        </p>
                    </div>
                </div>

                {step === "input" && (
                    <div className="space-y-4">
                        <div className="flex gap-1 bg-white/5 rounded-lg p-1">
                            <button
                                onClick={() => setImportMode("url")}
                                className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${
                                    importMode === "url"
                                        ? "bg-white/10 text-white"
                                        : "text-gray-400 hover:text-gray-300"
                                }`}
                            >
                                <Link className="w-4 h-4" />
                                {ru.import.urlMode}
                            </button>
                            <button
                                onClick={() => setImportMode("file")}
                                className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${
                                    importMode === "file"
                                        ? "bg-white/10 text-white"
                                        : "text-gray-400 hover:text-gray-300"
                                }`}
                            >
                                <FileUp className="w-4 h-4" />
                                {ru.import.fileMode}
                            </button>
                        </div>

                        {importMode === "url" && (
                            <>
                                <div>
                                    <label className="block text-sm font-medium text-gray-300 mb-2">
                                        {ru.import.urlLabel}
                                    </label>
                                    <input
                                        type="text"
                                        value={urlInput}
                                        onChange={(event) =>
                                            setUrlInput(event.target.value)
                                        }
                                        placeholder={
                                            importPageRu.urlPlaceholder
                                        }
                                        className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand transition-colors"
                                        onKeyDown={(event) =>
                                            event.key === "Enter" &&
                                            void handleSubmitBackgroundJob(
                                                urlInput,
                                            )
                                        }
                                    />
                                    <p className="text-xs text-gray-400 mt-2">
                                        {importPageRu.urlHint}
                                    </p>
                                    <p className="mt-2 text-xs leading-5 text-gray-400">
                                        {importPageRu.spotifyBoundary}
                                    </p>
                                </div>
                                <div className="space-y-2">
                                    <button
                                        onClick={() =>
                                            void handleSubmitBackgroundJob(
                                                urlInput,
                                            )
                                        }
                                        disabled={
                                            isJobSubmitting || !urlInput.trim()
                                        }
                                        className="w-full py-3 rounded-full font-medium bg-brand text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                                    >
                                        {isJobSubmitting ? (
                                            <>
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                {ru.import.starting}
                                            </>
                                        ) : (
                                            <>{ru.import.start}</>
                                        )}
                                    </button>
                                    <p className="text-center text-xs text-gray-400">
                                        {ru.import.backgroundHint}
                                    </p>
                                </div>
                            </>
                        )}

                        {importMode === "file" && (
                            <>
                                <div>
                                    <label className="block text-sm font-medium text-gray-300 mb-2">
                                        {ru.import.m3uLabel}
                                    </label>
                                    <div
                                        onClick={() =>
                                            fileInputRef.current?.click()
                                        }
                                        className="w-full bg-white/5 border border-dashed border-white/20 rounded-lg px-4 py-8 text-center cursor-pointer hover:border-white/40 hover:bg-white/[0.07] transition-colors"
                                    >
                                        <FileUp className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                                        {m3uFileName ? (
                                            <p className="text-sm text-white">
                                                {m3uFileName}
                                            </p>
                                        ) : (
                                            <p className="text-sm text-gray-400">
                                                {ru.import.selectM3u}
                                            </p>
                                        )}
                                    </div>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".m3u,.m3u8"
                                        className="hidden"
                                        onChange={handleM3uFileSelect}
                                    />
                                    <p className="text-xs text-gray-400 mt-2">
                                        {importPageRu.m3uMatchHint}
                                    </p>
                                </div>
                                {m3uContent && (
                                    <div>
                                        <label className="block text-sm font-medium text-gray-300 mb-2">
                                            {ru.import.playlistName}
                                        </label>
                                        <input
                                            type="text"
                                            value={m3uPlaylistName}
                                            onChange={(event) =>
                                                setM3uPlaylistName(
                                                    event.target.value,
                                                )
                                            }
                                            placeholder={
                                                ru.import
                                                    .playlistNamePlaceholder
                                            }
                                            className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand transition-colors"
                                        />
                                    </div>
                                )}
                                <button
                                    onClick={() => void fetchM3uPreview()}
                                    disabled={isPreviewLoading || !m3uContent}
                                    className="w-full py-3 rounded-full font-medium bg-brand text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                                >
                                    {isPreviewLoading ? (
                                        <>
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            {ru.import.matching}
                                        </>
                                    ) : (
                                        <>{ru.import.previewImport}</>
                                    )}
                                </button>
                            </>
                        )}
                    </div>
                )}

                {step === "preview" && preview && (
                    <div className="space-y-4">
                        <div className="flex items-start gap-4 p-4 bg-white/5 rounded-lg">
                            <div className="w-12 h-12 rounded-md bg-white/10 flex items-center justify-center">
                                <Music4 className="w-6 h-6 text-gray-300" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <h2 className="text-lg font-bold text-white truncate">
                                    {preview.playlistName}
                                </h2>
                                <p className="text-sm text-gray-400">
                                    {formatImportSongsFound(
                                        preview.summary.total,
                                    )}
                                </p>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                            <div className="text-center py-3 bg-white/5 rounded-lg">
                                <div className="text-xl font-bold text-white">
                                    {preview.summary.total}
                                </div>
                                <div className="text-xs text-gray-400">
                                    {ru.import.total}
                                </div>
                            </div>
                            <div className="text-center py-3 bg-emerald-500/10 rounded-lg">
                                <div className="text-xl font-bold text-emerald-300">
                                    {preview.summary.local}
                                </div>
                                <div className="text-xs text-gray-400">
                                    {importPageRu.localSummary}
                                </div>
                            </div>
                            <div className="text-center py-3 bg-red-500/10 rounded-lg">
                                <div className="text-xl font-bold text-red-300">
                                    {preview.summary.youtube}
                                </div>
                                <div className="text-xs text-gray-400">
                                    YouTube
                                </div>
                            </div>
                            <div className="text-center py-3 bg-[#00BFFF]/10 rounded-lg">
                                <div className="text-xl font-bold text-[#00BFFF]">
                                    {preview.summary.tidal}
                                </div>
                                <div className="text-xs text-gray-400">
                                    TIDAL
                                </div>
                            </div>
                            <div className="text-center py-3 bg-red-500/10 rounded-lg">
                                <div className="text-xl font-bold text-red-400">
                                    {preview.summary.unresolved}
                                </div>
                                <div className="text-xs text-gray-400">
                                    {ru.import.unresolved}
                                </div>
                            </div>
                        </div>

                        <div className="bg-white/5 rounded-lg overflow-hidden">
                            <div className="px-4 py-3 border-b border-white/5">
                                <h3 className="text-sm font-medium text-white">
                                    {ru.import.resolutionPreview}
                                </h3>
                            </div>
                            <PreviewTrackResolutionList
                                tracks={preview.resolved}
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">
                                {ru.import.playlistName}
                            </label>
                            <input
                                type="text"
                                value={playlistName}
                                onChange={(event) =>
                                    setPlaylistName(event.target.value)
                                }
                                placeholder={ru.import.playlistNamePlaceholder}
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1DB954]/50 focus:border-[#1DB954] transition-colors"
                            />
                        </div>

                        <div className="flex items-center gap-3 pt-2">
                            <button
                                onClick={returnToInput}
                                className="px-6 py-3 rounded-full text-sm font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
                            >
                                {ru.import.back}
                            </button>
                            <button
                                onClick={() => void handleExecute()}
                                disabled={isExecuting || importableCount <= 0}
                                className="flex-1 py-3 rounded-full font-medium bg-[#1DB954] text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                            >
                                {isExecuting ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        {ru.import.importing}
                                    </>
                                ) : importableCount > 0 ? (
                                    `${ru.import.createPlaylist} (${importableCount})`
                                ) : (
                                    <>{ru.import.noImportable}</>
                                )}
                            </button>
                        </div>
                    </div>
                )}

                {step === "executing" && (
                    <div className="text-center py-12">
                        <Loader2 className="w-10 h-10 text-[#1DB954] animate-spin mx-auto mb-4" />
                        <h2 className="text-lg font-bold text-white mb-1">
                            {ru.import.creatingPlaylist}
                        </h2>
                        <p className="text-sm text-gray-400">
                            {ru.import.buildingPlaylist}
                        </p>
                    </div>
                )}

                {step === "complete" && result && (
                    <div className="text-center py-12">
                        <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4 bg-[#1DB954]">
                            <Check className="w-7 h-7 text-black" />
                        </div>
                        <h2 className="text-lg font-bold text-white mb-1">
                            {ru.import.complete}
                        </h2>
                        <p className="text-sm text-gray-400">
                            {ru.import.added} {completedImportableCount}{" "}
                            {ru.import.toNewPlaylist}
                        </p>
                        {result.summary.unresolved > 0 && (
                            <p className="text-sm text-amber-400 mt-2">
                                {formatImportSkipped(result.summary.unresolved)}
                            </p>
                        )}

                        <div className="flex items-center justify-center gap-3 mt-6">
                            <button
                                onClick={resetFlow}
                                className="px-5 py-2.5 rounded-full text-sm font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
                            >
                                {ru.import.importAnother}
                            </button>
                            <button
                                onClick={() =>
                                    router.push(
                                        `/playlist/${result.playlistId}`,
                                    )
                                }
                                className="px-5 py-2.5 rounded-full text-sm font-medium bg-[#1DB954] text-black hover:brightness-110 transition-all"
                            >
                                {ru.import.viewPlaylist}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * Renders the ImportPage component.
 */
export default function ImportPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-screen flex items-center justify-center">
                    <Loader2 className="w-8 h-8 text-brand animate-spin" />
                </div>
            }
        >
            <ImportPageContent />
        </Suspense>
    );
}
