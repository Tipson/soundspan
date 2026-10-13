"use client";

import {
    api,
    type ImportResolutionSource,
    type PlaylistImportExecuteResponse,
    type PlaylistImportPreviewResponse,
    type PlaylistImportResolvedTrack,
} from "@/lib/api";
import {
    formatImportResolutionSubtitle,
    importPageRu,
} from "@/lib/i18n/utilityPagesRu";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { formatTime } from "@/utils/formatTime";
/** Parse an HTTP(S) playlist address, accepting an omitted scheme. */
export function tryParsePlaylistUrl(rawInput: string): URL | null {
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
 * Accepts playlist addresses for the providers supported by the import screen.
 */
export function isSupportedPlaylistUrl(url: string): boolean {
    const parsed = tryParsePlaylistUrl(url);
    if (!parsed) return false;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    const path = parsed.pathname;

    if (
        [
            "music.yandex.ru",
            "music.yandex.com",
            "music.yandex.kz",
            "music.yandex.by",
            "music.yandex.uz",
        ].includes(hostname)
    ) {
        if (parsed.username || parsed.password || parsed.port) return false;
        return (
            /^\/users\/[a-z0-9][a-z0-9._-]{0,99}\/playlists\/\d{1,20}\/?$/i.test(
                path,
            ) ||
            /^\/playlists\/(?:[a-z]{1,16}\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(
                path,
            )
        );
    }

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

    return false;
}

/**
 * Creates the previewed playlist through the shared API boundary.
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
                            <div className="line-clamp-2 break-words text-sm text-content">
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
