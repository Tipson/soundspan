import { api } from "@/lib/api";
import { useDownloadContext } from "@/lib/download-context";
import { toast } from "sonner";
import type { Album } from "../types";
import { resolveAcquisitionMbid } from "../albumActionVisibility";
import {
    albumRu,
    formatAlbumDownloading,
    formatAlbumDownloadPreparing,
} from "@/lib/i18n/musicPagesRu";

interface AlbumAcquisitionRequest {
    artistName: string;
    albumTitle: string;
    mbid: string;
}

function getAlbumAcquisitionRequest(
    album: Album | null,
): AlbumAcquisitionRequest | null {
    if (!album) {
        toast.error(albumRu.dataUnavailable);
        return null;
    }
    const mbid = resolveAcquisitionMbid(album);
    if (!mbid) {
        toast.error(albumRu.mbidUnavailable);
        return null;
    }
    return {
        artistName: album.artist?.name || "Unknown Artist",
        albumTitle: album.title,
        mbid,
    };
}

async function startAlbumDownload(
    request: AlbumAcquisitionRequest,
    addPendingDownload: ReturnType<
        typeof useDownloadContext
    >["addPendingDownload"],
): Promise<void> {
    addPendingDownload("album", request.albumTitle, request.mbid);
    toast.loading(formatAlbumDownloadPreparing(request.albumTitle), {
        id: `download-${request.mbid}`,
    });
    try {
        await api.downloadAlbum(
            request.artistName,
            request.albumTitle,
            request.mbid,
        );
        toast.success(formatAlbumDownloading(request.albumTitle), {
            id: `download-${request.mbid}`,
        });
    } catch {
        toast.error(albumRu.downloadStartFailed, {
            id: `download-${request.mbid}`,
        });
    }
}

/** Provides album acquisition with synthetic-MBID rejection. */
export function useAlbumAcquisition() {
    const { addPendingDownload, isPendingByMbid } = useDownloadContext();
    return async (album: Album | null, event?: React.MouseEvent) => {
        event?.stopPropagation();
        const request = getAlbumAcquisitionRequest(album);
        if (!request) return;
        if (isPendingByMbid(request.mbid)) {
            toast.info(albumRu.alreadyDownloading);
            return;
        }
        await startAlbumDownload(request, addPendingDownload);
    };
}
