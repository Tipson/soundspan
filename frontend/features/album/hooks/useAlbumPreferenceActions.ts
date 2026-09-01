import { useMemo, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { TrackPreferenceResponse, TrackPreferenceSignal } from "@/lib/api";
import { buildOptimisticTrackPreferenceResponse } from "@/hooks/trackPreferenceOptimistic";
import { toast } from "sonner";
import type { Album } from "../types";
import { queryKeys } from "@/lib/queryKeys";
import { publishDeviceOfflineLikedChangeForSignal } from "@/features/device-offline/likedAutomation";
import { albumRu, formatAlbumPreferenceSuccess } from "@/lib/i18n/musicPagesRu";

function albumTrackIds(album: Album): string[] {
    return Array.from(
        new Set(
            (album.tracks || [])
                .map((track) => track.id)
                .filter((trackId) => trackId.trim().length > 0),
        ),
    );
}

/** Provides album-wide preference mutation and optimistic cache updates. */
export function useAlbumPreferenceActions() {
    const queryClient = useQueryClient();
    const [isApplyingAlbumPreference, setIsApplyingAlbumPreference] =
        useState(false);

    const setAlbumPreference = async (
        album: Album | null,
        signal: TrackPreferenceSignal,
    ) => {
        if (!album) return toast.error(albumRu.dataUnavailable);
        const trackIds = albumTrackIds(album);
        if (trackIds.length === 0) {
            return toast.info(albumRu.noTracksForPreference);
        }
        setIsApplyingAlbumPreference(true);
        try {
            await api.setAlbumPreference(album.id, signal);
            trackIds.forEach((trackId) =>
                queryClient.setQueryData(
                    ["track-preference", trackId],
                    buildOptimisticTrackPreferenceResponse(trackId, signal),
                ),
            );
            await queryClient.invalidateQueries({
                queryKey: queryKeys.likedPlaylistAll(),
            });
            publishDeviceOfflineLikedChangeForSignal(signal);
            toast.success(
                formatAlbumPreferenceSuccess(signal, trackIds.length),
            );
        } catch {
            toast.error(albumRu.preferenceUpdateFailed);
        } finally {
            setIsApplyingAlbumPreference(false);
        }
    };

    return { setAlbumPreference, isApplyingAlbumPreference };
}

/** Returns whether every album track currently has a thumbs-up preference. */
export function useAlbumLikedState(album: Album | null) {
    const trackIds = useMemo(
        () => (album ? albumTrackIds(album) : []),
        [album],
    );
    const preferenceQueries = useQueries({
        queries: trackIds.map((trackId) => ({
            queryKey: queryKeys.trackPreference(trackId),
            queryFn: () => api.getTrackPreference(trackId),
            staleTime: 120_000,
            enabled: trackIds.length > 0,
        })),
    });

    return useMemo(
        () =>
            trackIds.length > 0 &&
            preferenceQueries.every(
                (query) =>
                    (query.data as TrackPreferenceResponse | undefined)
                        ?.signal === "thumbs_up",
            ),
        [trackIds.length, preferenceQueries],
    );
}
