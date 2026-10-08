import {
    getCollectionPlaybackGeneration,
    markCollectionPlayback,
} from "@/lib/collectionPlayback";
import { useCallback } from "react";
import { useAudioControls, usePlaybackStatus } from "@/lib/audio-context";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { shuffleArray } from "@/utils/shuffle";
import { DiscoverPlaylist } from "../types";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { discoverQueuedCount, discoverRu } from "@/lib/i18n/discoverRu";
import { mapDiscoverTrackToPlaybackTrack } from "../playback";
import type { Track } from "@/lib/audio-state-context";

export { mapDiscoverTrackToPlaybackTrack } from "../playback";

function playbackTracks(playlist: DiscoverPlaylist): Track[] {
    return playlist.tracks
        .map(mapDiscoverTrackToPlaybackTrack)
        .filter((track): track is Track => track !== null);
}

/**
 * Executes useDiscoverActions.
 */
export function useDiscoverActions(
    playlist: DiscoverPlaylist | null,
    isGenerating?: boolean,
    refreshBatchStatus?: () => Promise<unknown>,
    setPendingGeneration?: (pending: boolean) => void,
) {
    const { playTracks, playNow, addTracksToQueue, pause, resume } =
        useAudioControls();
    const { isPlaying } = usePlaybackStatus();

    const handleGenerate = useCallback(async () => {
        if (isGenerating) {
            sharedFrontendLogger.warn(
                "Generation already in progress, ignoring request",
            );
            toast.warning(discoverRu.toast.generationInProgress);
            return;
        }

        // Set optimistic state immediately to prevent double-clicks
        setPendingGeneration?.(true);

        try {
            toast.info(discoverRu.toast.generating);
            await api.generateDiscoverWeekly();

            // Immediately refresh batch status to start polling
            if (refreshBatchStatus) {
                await refreshBatchStatus();
            }

            toast.success(discoverRu.toast.generationStarted);
        } catch (error: unknown) {
            sharedFrontendLogger.error("Generation failed:", error);
            // Clear pending state on error
            setPendingGeneration?.(false);
            const err = error as Error & { status?: number };
            if (err.status === 409) {
                toast.warning(discoverRu.toast.generationInProgress);
                // Refresh status in case UI is out of sync
                if (refreshBatchStatus) {
                    await refreshBatchStatus();
                }
            } else {
                toast.error(discoverRu.toast.generationFailed);
            }
        }
    }, [isGenerating, refreshBatchStatus, setPendingGeneration]);

    const handlePlayPlaylist = useCallback(() => {
        if (!playlist || playlist.tracks.length === 0) return;

        const formattedTracks = playbackTracks(playlist);
        if (!formattedTracks.length) return;

        const collectionGeneration = getCollectionPlaybackGeneration();
        playTracks(formattedTracks, 0, false, {
            replaceQueue: true,
            preserveOrder: true,
        });
        markCollectionPlayback(
            `discover:${playlist.weekStart}`,
            collectionGeneration,
        );
    }, [playlist, playTracks]);

    const handleShufflePlaylist = useCallback(() => {
        if (!playlist || playlist.tracks.length === 0) return;

        const formattedTracks = playbackTracks(playlist);
        if (!formattedTracks.length) return;

        const collectionGeneration = getCollectionPlaybackGeneration();
        playTracks(shuffleArray(formattedTracks), 0, false, {
            replaceQueue: true,
            preserveOrder: true,
        });
        markCollectionPlayback(
            `discover:${playlist.weekStart}`,
            collectionGeneration,
        );
    }, [playlist, playTracks]);

    const handlePlayTrack = useCallback(
        (index: number) => {
            if (!playlist || playlist.tracks.length === 0) return;
            if (index < 0 || index >= playlist.tracks.length) return;

            const formattedTrack = mapDiscoverTrackToPlaybackTrack(
                playlist.tracks[index],
            );
            if (!formattedTrack) return;
            playNow(formattedTrack);
        },
        [playlist, playNow],
    );

    const handleAddAllToQueue = useCallback(() => {
        if (!playlist || playlist.tracks.length === 0) return;
        const formattedTracks = playbackTracks(playlist);
        if (!formattedTracks.length) return;
        addTracksToQueue(formattedTracks);
        toast.success(discoverQueuedCount(formattedTracks.length));
    }, [playlist, addTracksToQueue]);

    const handleTogglePlay = useCallback(() => {
        if (isPlaying) {
            pause();
        } else {
            resume();
        }
    }, [isPlaying, pause, resume]);

    return {
        handleGenerate,
        handlePlayPlaylist,
        handleShufflePlaylist,
        handlePlayTrack,
        handleTogglePlay,
        handleAddAllToQueue,
    };
}
