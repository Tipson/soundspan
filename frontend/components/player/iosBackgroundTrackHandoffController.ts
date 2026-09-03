import { resolveDeviceOfflineMediaIdentity } from "@/features/device-offline/playbackResolver";
import { getNextTrackInfo } from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import {
    audioEngine,
    logPlaybackClientMetric,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { detectIosStandalonePwaEnvironment } from "@/lib/audio-engine/iosStandalonePwaBridge";
import { getListenTogetherSessionSnapshot } from "@/lib/listen-together-session";
import type { QueueItem } from "@/lib/queue-item";
import { resolvePlaybackDuration } from "./audioPlaybackOrchestratorPolicy";
import type { PlaybackOrchestratorRefs } from "./hooks/usePlaybackOrchestratorRefs";

interface ObserveIosBackgroundTrackHandoffOptions {
    refs: PlaybackOrchestratorRefs;
    queue: QueueItem[];
    currentIndex: number;
    isShuffle: boolean;
    shuffleIndices: number[];
    repeatMode: "off" | "one" | "all";
    liveTrackId: string | null;
    currentTimeSec: number;
    loadedDurationSec: number;
}

/**
 * Advances a prepared next item just before WebKit ends the active source.
 * Every browser/platform gate lives here so the main orchestrator stays small.
 */
export function observeIosBackgroundTrackHandoff({
    refs,
    queue,
    currentIndex,
    isShuffle,
    shuffleIndices,
    repeatMode,
    liveTrackId,
    currentTimeSec,
    loadedDurationSec,
}: ObserveIosBackgroundTrackHandoffOptions): void {
    const nextTrack = getNextTrackInfo(
        queue,
        currentIndex,
        isShuffle,
        shuffleIndices,
        repeatMode,
    );
    const nextTrackIdentity = nextTrack
        ? resolveDeviceOfflineMediaIdentity(nextTrack)
        : null;
    const handoffTrack = refs.currentTrackRef.current;
    const durationSec = resolvePlaybackDuration({
        loadedDurationSec,
        metadataDurationSec: handoffTrack?.duration ?? 0,
        isRemoteStream:
            handoffTrack?.streamSource === "tidal" ||
            handoffTrack?.streamSource === "youtube",
    });

    refs.iosBackgroundTrackHandoffRef.current.observe(
        {
            occurrenceId: `${currentIndex}:${liveTrackId ?? "none"}:${refs.loadIdRef.current}:${nextTrackIdentity ?? "none"}`,
            activeEngine: audioEngine.getActiveEngineDescriptor(),
            isIosStandalonePwa: detectIosStandalonePwaEnvironment(),
            isDocumentHidden:
                typeof document !== "undefined" &&
                document.visibilityState === "hidden",
            isPlaying: audioEngine.isPlaying(),
            isLoading: refs.isLoadingRef.current,
            isListenTogether: Boolean(
                getListenTogetherSessionSnapshot()?.groupId,
            ),
            repeatMode,
            hasNextTrack: Boolean(nextTrack),
            nextTrackPreloadRequested:
                nextTrackIdentity !== null &&
                nextTrackIdentity === refs.lastPreloadedTrackIdRef.current,
            currentTimeSec,
            durationSec,
        },
        () => {
            const sourceStillActive =
                refs.playbackTypeRef.current === "track" &&
                refs.currentTrackRef.current?.id === liveTrackId &&
                !refs.isLoadingRef.current &&
                audioEngine.isPlaying();
            const stillHidden =
                typeof document !== "undefined" &&
                document.visibilityState === "hidden";
            if (
                !sourceStillActive ||
                !stillHidden ||
                audioEngine.getActiveEngineDescriptor() !== "native" ||
                !detectIosStandalonePwaEnvironment() ||
                getListenTogetherSessionSnapshot()?.groupId
            ) {
                refs.iosBackgroundTrackHandoffRef.current.reset();
                return;
            }
            logPlaybackClientMetric("player.ios_background_handoff", {
                trackId: liveTrackId,
                nextTrackId: nextTrack?.id ?? null,
                remainingSec: Math.max(0, durationSec - currentTimeSec),
            });
            refs.engineEventHandlersRef.current?.handleEnd(true);
        },
    );
}
