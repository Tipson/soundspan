"use client";

import { toast } from "sonner";
import {
    openRequestRgMbids,
    useCreateMusicRequest,
    useMyMusicRequests,
    useRequestsGate,
} from "@/hooks/useMusicRequests";
import { isRequestableMbid } from "@/lib/musicRequests";
import type { Album } from "../types";
import {
    formatReleaseRequestedRu,
    formatRequestingReleaseRu,
    libraryOperationsRu,
} from "@/lib/i18n/libraryOperationsRu";
import { userFacingError } from "@/lib/i18n/ru";

/**
 * Request-flow state for the artist page's album grids: which albums the
 * caller may request, which already carry an open request, and a
 * toast-wrapped submit. Closed for admins and anonymous viewers.
 */
export function useArtistAlbumRequests(artistName: string) {
    const { requestsEnabled } = useRequestsGate();
    const myRequests = useMyMusicRequests(requestsEnabled);
    const create = useCreateMusicRequest();
    const openRgMbids = openRequestRgMbids(myRequests.data);

    const albumRgMbid = (album: Album): string | null => {
        const candidate = album.rgMbid || album.mbid || null;
        return isRequestableMbid(candidate) ? candidate : null;
    };

    const isRequestedAlbum = (album: Album): boolean => {
        const rgMbid = albumRgMbid(album);
        return Boolean(rgMbid && openRgMbids.has(rgMbid.toLowerCase()));
    };

    const requestAlbum = async (album: Album): Promise<void> => {
        const rgMbid = albumRgMbid(album);
        if (!rgMbid || create.isPending) return;
        const toastId = `music-request-${rgMbid}`;
        toast.loading(formatRequestingReleaseRu(album.title), { id: toastId });
        try {
            await create.mutateAsync({
                artistName,
                albumTitle: album.title,
                rgMbid,
            });
            toast.success(formatReleaseRequestedRu(album.title), {
                id: toastId,
            });
        } catch (error) {
            toast.error(
                userFacingError(
                    error,
                    libraryOperationsRu.requests.actionFailed,
                ),
                { id: toastId },
            );
        }
    };

    return {
        requestsEnabled,
        isRequestableAlbum: (album: Album) => albumRgMbid(album) !== null,
        isRequestedAlbum,
        isSubmittingRequest: create.isPending,
        requestAlbum,
    };
}
