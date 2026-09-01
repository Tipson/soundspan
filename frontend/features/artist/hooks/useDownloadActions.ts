import { useCallback } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { useDownloadContext } from "@/lib/download-context";
import { Artist, Album } from "../types";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    artistRu,
    formatAlbumDownloadAlreadyQueued,
    formatAlbumDownloading,
    formatAlbumDownloadPreparing,
    formatArtistAlbumsQueued,
    formatArtistDiscographyCheck,
    formatArtistDownloadAlreadyQueued,
} from "@/lib/i18n/musicPagesRu";

/**
 * Executes useDownloadActions.
 */
export function useDownloadActions() {
    const { addPendingDownload, removePendingByMbid, isPendingByMbid } =
        useDownloadContext();

    const downloadArtist = useCallback(
        async (artist: Artist | null) => {
            if (!artist) {
                toast.error(artistRu.noArtistSelected);
                return;
            }

            if (!artist.mbid) {
                toast.error(artistRu.artistMbidUnavailable);
                return;
            }

            // Check if already downloading
            if (isPendingByMbid(artist.mbid)) {
                toast.info(formatArtistDownloadAlreadyQueued(artist.name));
                return;
            }

            try {
                // Add to pending downloads
                addPendingDownload("artist", artist.name, artist.mbid);

                // Show immediate feedback
                toast.loading(formatArtistDiscographyCheck(artist.name), {
                    id: `download-${artist.mbid}`,
                });

                // Trigger background enumeration of missing albums
                await api.downloadArtist(artist.name, artist.mbid);

                // Update the loading toast to success
                toast.success(formatArtistAlbumsQueued(artist.name), {
                    id: `download-${artist.mbid}`,
                });
            } catch (error: unknown) {
                sharedFrontendLogger.error("Failed to download artist:", error);
                // The request never became a job, so clear the local pending
                // entry — otherwise the button stays disabled until the stale
                // sweep runs.
                removePendingByMbid(artist.mbid);
                toast.error(artistRu.downloadArtistFailed, {
                    id: `download-${artist.mbid}`,
                });
            }
        },
        [addPendingDownload, removePendingByMbid, isPendingByMbid],
    );

    const downloadAlbum = useCallback(
        async (album: Album, artistName: string, e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            // Get MBID (prefer rgMbid, fallback to mbid)
            const mbid = album.rgMbid || album.mbid;

            if (!mbid) {
                toast.error(artistRu.albumMbidUnavailable);
                return;
            }

            // Check if already downloading
            if (isPendingByMbid(mbid)) {
                toast.info(formatAlbumDownloadAlreadyQueued(album.title));
                return;
            }

            try {
                // Add to pending downloads
                addPendingDownload(
                    "album",
                    `${artistName} - ${album.title}`,
                    mbid,
                );

                // Show immediate feedback
                toast.loading(formatAlbumDownloadPreparing(album.title), {
                    id: `download-${mbid}`,
                });

                // Trigger download
                await api.downloadAlbum(artistName, album.title, mbid);

                // Update the loading toast to success
                toast.success(formatAlbumDownloading(album.title), {
                    id: `download-${mbid}`,
                });
            } catch (error: unknown) {
                sharedFrontendLogger.error("Failed to download album:", error);
                // The request never became a job, so clear the local pending
                // entry — otherwise the button stays disabled until the stale
                // sweep runs.
                removePendingByMbid(mbid);
                toast.error(artistRu.downloadAlbumFailed, {
                    id: `download-${mbid}`,
                });
            }
        },
        [addPendingDownload, removePendingByMbid, isPendingByMbid],
    );

    return {
        downloadArtist,
        downloadAlbum,
    };
}
