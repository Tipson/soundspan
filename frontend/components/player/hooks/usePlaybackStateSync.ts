import { useEffect } from "react";
import type { Track } from "@/lib/audio-state-context";
import type { PlaybackStreamProfile } from "@/lib/audio-playback-context";
import { resolveDirectTrackSourceType } from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { usePlaybackRecoveryHelpers } from "./usePlaybackRecoveryHelpers";

interface UsePlaybackStateSyncOptions {
    refs: PlaybackOrchestratorRefs;
    playbackRecoveryHelpers: ReturnType<typeof usePlaybackRecoveryHelpers>;
    currentTrack: Track | null;
    playbackType: "track" | "audiobook" | "podcast" | null;
    queueLength: number;
    setStreamProfile: (profile: PlaybackStreamProfile | null) => void;
}

/** Keeps orchestrator refs synchronized with React playback state. */
export function usePlaybackStateSync({
    refs,
    playbackRecoveryHelpers,
    currentTrack,
    playbackType,
    queueLength,
    setStreamProfile,
}: UsePlaybackStateSyncOptions): void {
    const { clearTransientTrackRecovery } = playbackRecoveryHelpers;
    const {
        currentTrackRef,
        trackEndWatchdogRef,
        startupRecoveryAttemptedTrackIdRef,
        transientTrackRecoveryTrackIdRef,
        queueLengthRef,
        playbackTypeRef,
    } = refs;

    useEffect(() => {
        const previousTrackId = currentTrackRef.current?.id ?? null;
        currentTrackRef.current = currentTrack;
        const currentTrackId = currentTrack?.id ?? null;
        if (previousTrackId !== currentTrackId) {
            trackEndWatchdogRef.current?.clear();
        }
        if (currentTrack?.id !== startupRecoveryAttemptedTrackIdRef.current) {
            startupRecoveryAttemptedTrackIdRef.current = null;
        }
        if (currentTrack?.id !== transientTrackRecoveryTrackIdRef.current) {
            clearTransientTrackRecovery(true);
        }
        if (currentTrack) {
            setStreamProfile({
                mode: "direct",
                sourceType: resolveDirectTrackSourceType(currentTrack),
                codec: null,
                bitrateKbps: null,
            });
        } else {
            setStreamProfile(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [currentTrack, clearTransientTrackRecovery, setStreamProfile]);

    useEffect(() => {
        queueLengthRef.current = queueLength;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [queueLength]);

    useEffect(() => {
        playbackTypeRef.current = playbackType;
        if (playbackType !== "track") {
            trackEndWatchdogRef.current?.clear();
            setStreamProfile(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [playbackType, setStreamProfile]);
}
