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
import { PageHeader } from "@/components/layout/PageHeader";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
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
                className="shrink-0 rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-bold text-success"
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
            className="shrink-0 rounded bg-error/15 px-1.5 py-0.5 text-[10px] font-bold text-error"
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
            <div className="p-4 text-sm text-content-muted">
                {importPageRu.noTracks}
            </div>
        );
    }

    return (
        <div className="max-h-96 divide-y divide-line overflow-y-auto">
            {tracks.map((track, idx) => (
                <div
                    key={`${track.index}-${track.artist}-${track.title}-${idx}`}
                    className="px-4 py-3 transition-colors hover:bg-surface-elevated/70 motion-reduce:transition-none"
                >
                    <div className="flex items-start gap-3">
                        <span className="w-6 pt-0.5 text-right text-xs tabular-nums text-content-muted">
                            {idx + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                            <div className="truncate text-sm text-content">
                                {track.title}
                            </div>
                            <div className="truncate text-xs text-content-muted">
                                {track.artist}
                                {track.album ? ` • ${track.album}` : ""}
                            </div>
                            <div className="mt-1 text-[11px] text-content-muted">
                                {getResolutionSubtitle(track)}
                            </div>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                            <ImportResolutionBadge source={track.source} />
                            {typeof track.duration === "number" &&
                                track.duration > 0 && (
                                    <span className="text-[11px] tabular-nums text-content-muted">
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
        <div data-consumer-surface="import" className="min-h-screen bg-surface">
            <div className="relative mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
                <PageHeader
                    title={ru.import.playlistTitle}
                    subtitle={ru.import.servicesOrFile}
                    icon={Music4}
                    actions={
                        <button
                            type="button"
                            aria-label={importPageRu.back}
                            onClick={() => router.back()}
                            className="flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-surface-elevated text-content-muted transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        >
                            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
                        </button>
                    }
                />

                {step === "input" && (
                    <div className="space-y-6">
                        <div
                            role="tablist"
                            aria-label="Способ импорта"
                            className="flex gap-1 border-y border-line py-2"
                        >
                            <button
                                type="button"
                                role="tab"
                                aria-selected={importMode === "url"}
                                onClick={() => setImportMode("url")}
                                className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none ${
                                    importMode === "url"
                                        ? "bg-surface-hover text-content"
                                        : "text-content-muted hover:bg-surface-elevated hover:text-content"
                                }`}
                            >
                                <Link className="w-4 h-4" />
                                {ru.import.urlMode}
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={importMode === "file"}
                                onClick={() => setImportMode("file")}
                                className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none ${
                                    importMode === "file"
                                        ? "bg-surface-hover text-content"
                                        : "text-content-muted hover:bg-surface-elevated hover:text-content"
                                }`}
                            >
                                <FileUp className="w-4 h-4" />
                                {ru.import.fileMode}
                            </button>
                        </div>

                        {importMode === "url" && (
                            <>
                                <div>
                                    <label
                                        htmlFor="playlist-import-url"
                                        className="mb-2 block text-sm font-medium text-content-secondary"
                                    >
                                        {ru.import.urlLabel}
                                    </label>
                                    <input
                                        type="text"
                                        id="playlist-import-url"
                                        value={urlInput}
                                        onChange={(event) =>
                                            setUrlInput(event.target.value)
                                        }
                                        placeholder={
                                            importPageRu.urlPlaceholder
                                        }
                                        className="min-h-12 w-full rounded-xl border border-line bg-surface-elevated px-4 py-3 text-base text-content outline-none transition-colors placeholder:text-content-muted hover:border-line-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20 sm:text-sm"
                                        onKeyDown={(event) =>
                                            event.key === "Enter" &&
                                            void handleSubmitBackgroundJob(
                                                urlInput,
                                            )
                                        }
                                    />
                                    <p className="mt-2 text-xs text-content-muted">
                                        {importPageRu.urlHint}
                                    </p>
                                    <p className="mt-2 text-xs leading-5 text-content-muted">
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
                                        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 py-3 font-semibold text-surface transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                                    >
                                        {isJobSubmitting ? (
                                            <>
                                                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                                                {ru.import.starting}
                                            </>
                                        ) : (
                                            <>{ru.import.start}</>
                                        )}
                                    </button>
                                    <p className="text-center text-xs text-content-muted">
                                        {ru.import.backgroundHint}
                                    </p>
                                </div>
                            </>
                        )}

                        {importMode === "file" && (
                            <>
                                <div>
                                    <label className="mb-2 block text-sm font-medium text-content-secondary">
                                        {ru.import.m3uLabel}
                                    </label>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            fileInputRef.current?.click()
                                        }
                                        className="min-h-32 w-full cursor-pointer rounded-xl border border-dashed border-line-strong bg-surface-elevated px-4 py-8 text-center transition-colors hover:border-brand/50 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                    >
                                        <FileUp className="mx-auto mb-2 h-8 w-8 text-content-muted" />
                                        {m3uFileName ? (
                                            <p className="text-sm text-content">
                                                {m3uFileName}
                                            </p>
                                        ) : (
                                            <p className="text-sm text-content-muted">
                                                {ru.import.selectM3u}
                                            </p>
                                        )}
                                    </button>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".m3u,.m3u8"
                                        className="hidden"
                                        onChange={handleM3uFileSelect}
                                    />
                                    <p className="mt-2 text-xs text-content-muted">
                                        {importPageRu.m3uMatchHint}
                                    </p>
                                </div>
                                {m3uContent && (
                                    <div>
                                        <label
                                            htmlFor="m3u-playlist-name"
                                            className="mb-2 block text-sm font-medium text-content-secondary"
                                        >
                                            {ru.import.playlistName}
                                        </label>
                                        <input
                                            type="text"
                                            id="m3u-playlist-name"
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
                                            className="min-h-12 w-full rounded-xl border border-line bg-surface-elevated px-4 py-3 text-base text-content outline-none transition-colors placeholder:text-content-muted hover:border-line-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20 sm:text-sm"
                                        />
                                    </div>
                                )}
                                <button
                                    onClick={() => void fetchM3uPreview()}
                                    disabled={isPreviewLoading || !m3uContent}
                                    className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 py-3 font-semibold text-surface transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                                >
                                    {isPreviewLoading ? (
                                        <>
                                            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
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
                    <div className="space-y-6">
                        <div className="flex items-start gap-4 border-y border-line py-4">
                            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-elevated">
                                <Music4 className="h-6 w-6 text-content-secondary" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <h2 className="truncate text-lg font-bold text-content">
                                    {preview.playlistName}
                                </h2>
                                <p className="text-sm text-content-muted">
                                    {formatImportSongsFound(
                                        preview.summary.total,
                                    )}
                                </p>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-5">
                            <div className="bg-surface px-3 py-4 text-center">
                                <div className="text-xl font-bold tabular-nums text-content">
                                    {preview.summary.total}
                                </div>
                                <div className="text-xs text-content-muted">
                                    {ru.import.total}
                                </div>
                            </div>
                            <div className="bg-surface px-3 py-4 text-center">
                                <div className="text-xl font-bold tabular-nums text-success">
                                    {preview.summary.local}
                                </div>
                                <div className="text-xs text-content-muted">
                                    {importPageRu.localSummary}
                                </div>
                            </div>
                            <div className="bg-surface px-3 py-4 text-center">
                                <div className="text-xl font-bold tabular-nums text-content">
                                    {preview.summary.youtube}
                                </div>
                                <div className="text-xs text-content-muted">
                                    YouTube
                                </div>
                            </div>
                            <div className="bg-surface px-3 py-4 text-center">
                                <div className="text-xl font-bold tabular-nums text-brand-light">
                                    {preview.summary.tidal}
                                </div>
                                <div className="text-xs text-content-muted">
                                    TIDAL
                                </div>
                            </div>
                            <div className="bg-surface px-3 py-4 text-center">
                                <div className="text-xl font-bold tabular-nums text-error">
                                    {preview.summary.unresolved}
                                </div>
                                <div className="text-xs text-content-muted">
                                    {ru.import.unresolved}
                                </div>
                            </div>
                        </div>

                        <section className="overflow-hidden border-y border-line">
                            <div className="border-b border-line px-4 py-3">
                                <h3 className="text-sm font-semibold text-content">
                                    {ru.import.resolutionPreview}
                                </h3>
                            </div>
                            <PreviewTrackResolutionList
                                tracks={preview.resolved}
                            />
                        </section>

                        <div>
                            <label
                                htmlFor="resolved-playlist-name"
                                className="mb-2 block text-sm font-medium text-content-secondary"
                            >
                                {ru.import.playlistName}
                            </label>
                            <input
                                type="text"
                                id="resolved-playlist-name"
                                value={playlistName}
                                onChange={(event) =>
                                    setPlaylistName(event.target.value)
                                }
                                placeholder={ru.import.playlistNamePlaceholder}
                                className="min-h-12 w-full rounded-xl border border-line bg-surface-elevated px-4 py-3 text-base text-content outline-none transition-colors placeholder:text-content-muted hover:border-line-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20 sm:text-sm"
                            />
                        </div>

                        <div className="flex items-center gap-3 pt-2">
                            <button
                                onClick={returnToInput}
                                className="min-h-12 rounded-xl px-6 py-3 text-sm font-semibold text-content-muted transition-colors hover:bg-surface-elevated hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                            >
                                {ru.import.back}
                            </button>
                            <button
                                onClick={() => void handleExecute()}
                                disabled={isExecuting || importableCount <= 0}
                                className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-brand px-5 py-3 font-semibold text-surface transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                            >
                                {isExecuting ? (
                                    <>
                                        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
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
                    <div
                        data-consumer-state="loading"
                        className="border-y border-line py-14 text-center"
                    >
                        <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-brand motion-reduce:animate-none" />
                        <h2 className="mb-1 text-lg font-bold text-content">
                            {ru.import.creatingPlaylist}
                        </h2>
                        <p className="text-sm text-content-muted">
                            {ru.import.buildingPlaylist}
                        </p>
                    </div>
                )}

                {step === "complete" && result && (
                    <div className="border-y border-line py-14 text-center">
                        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-success/15">
                            <Check className="h-7 w-7 text-success" />
                        </div>
                        <h2 className="mb-1 text-lg font-bold text-content">
                            {ru.import.complete}
                        </h2>
                        <p className="text-sm text-content-muted">
                            {ru.import.added} {completedImportableCount}{" "}
                            {ru.import.toNewPlaylist}
                        </p>
                        {result.summary.unresolved > 0 && (
                            <p className="mt-2 text-sm text-warning">
                                {formatImportSkipped(result.summary.unresolved)}
                            </p>
                        )}

                        <div className="flex items-center justify-center gap-3 mt-6">
                            <button
                                onClick={resetFlow}
                                className="min-h-11 rounded-xl px-5 py-2.5 text-sm font-semibold text-content-muted transition-colors hover:bg-surface-elevated hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                            >
                                {ru.import.importAnother}
                            </button>
                            <button
                                onClick={() =>
                                    router.push(
                                        `/playlist/${result.playlistId}`,
                                    )
                                }
                                className="min-h-11 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-surface transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
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
        <Suspense fallback={<LoadingScreen message="Открываем импорт…" />}>
            <ImportPageContent />
        </Suspense>
    );
}
