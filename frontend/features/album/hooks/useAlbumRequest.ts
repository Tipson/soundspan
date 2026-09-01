"use client";

import { toast } from "sonner";
import {
    openRequestRgMbids,
    useCreateMusicRequest,
    useMyMusicRequests,
    useRequestsGate,
} from "@/hooks/useMusicRequests";
import { isSyntheticRgMbid } from "../albumActionVisibility";
import type { Album } from "../types";
import {
    formatReleaseRequestedRu,
    formatRequestingReleaseRu,
    libraryOperationsRu,
} from "@/lib/i18n/libraryOperationsRu";
import { ru, userFacingError } from "@/lib/i18n/ru";

/**
 * Request-flow state and submit action for the album page. Only meaningful
 * for non-admin viewers; the gate stays closed for everyone else.
 */
export function useAlbumRequest(album: Album | null | undefined) {
    const { requestsEnabled } = useRequestsGate();
    const myRequests = useMyMusicRequests(requestsEnabled);
    const create = useCreateMusicRequest();

    const candidate = album?.rgMbid || album?.mbid || null;
    const rgMbid =
        candidate && !isSyntheticRgMbid(candidate) ? candidate : null;
    const isRequestedAlbum = Boolean(
        rgMbid && openRequestRgMbids(myRequests.data).has(rgMbid.toLowerCase()),
    );

    const requestAlbum = async () => {
        if (!album || !rgMbid || create.isPending) return;
        const toastId = `music-request-${rgMbid}`;
        toast.loading(formatRequestingReleaseRu(album.title), { id: toastId });
        try {
            await create.mutateAsync({
                artistName: album.artist?.name || ru.common.unknownArtist,
                albumTitle: album.title,
                rgMbid,
                ...(album.artist?.mbid
                    ? { artistMbid: album.artist.mbid }
                    : {}),
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
        isRequestedAlbum,
        isSubmittingRequest: create.isPending,
        requestAlbum,
    };
}
