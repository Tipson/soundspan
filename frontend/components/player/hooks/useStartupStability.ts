import { useCallback } from "react";
import { UNEXPECTED_STOP_STARTUP_GUARD_MS } from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import {
    createStartupStabilityWindow,
    noteStartupProgressTransition,
} from "@/lib/audio-engine/playbackRecoveryPolicy";
import { resolveDirectTrackSourceType } from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import { logPlaybackClientMetric } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";

interface UseStartupStabilityOptions {
    refs: PlaybackOrchestratorRefs;
}

/**
 * Tracks whether the current track has produced real audible progress since
 * its load started. The startup watchdog and unexpected-stop suppression key
 * on this: an engine that claims isPlaying() while time stays frozen is a
 * startup failure, not healthy playback (GH #42 soak finding — applies to
 * the native and Howler engines alike).
 */
export function useStartupStability({ refs }: UseStartupStabilityOptions) {
    const {
        startupStabilityRef,
        unexpectedStopStartupGuardRef,
        playbackStartTimingRef,
        currentTrackRef,
        loadIdRef,
    } = refs;

    const markStartupStabilityWindow = useCallback(
        (trackId: string | null, reason: string): void => {
            startupStabilityRef.current = createStartupStabilityWindow(trackId);
            unexpectedStopStartupGuardRef.current = {
                trackId,
                suppressUntilMs: trackId
                    ? Date.now() + UNEXPECTED_STOP_STARTUP_GUARD_MS
                    : 0,
                reason: trackId ? reason : null,
            };
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const noteStartupProgress = useCallback(
        (trackId: string | null, timeSec: number): void => {
            const nowMs = Date.now();
            const previous = startupStabilityRef.current;
            const next = noteStartupProgressTransition(
                previous,
                trackId,
                timeSec,
                nowMs,
            );
            startupStabilityRef.current = next;

            const timing = playbackStartTimingRef.current;
            const firstAudibleProgress =
                previous.firstProgressAtMs === null &&
                next.firstProgressAtMs !== null;
            if (
                !firstAudibleProgress ||
                timing.reported ||
                timing.trackId !== trackId ||
                timing.loadId !== loadIdRef.current
            ) {
                return;
            }

            timing.reported = true;
            const sourceType = currentTrackRef.current
                ? resolveDirectTrackSourceType(currentTrackRef.current)
                : "unknown";
            logPlaybackClientMetric("player.audible_start", {
                durationMs: Math.max(0, nowMs - timing.startedAtMs),
                trackId,
                sourceType,
                outcome: "audible",
            });
            if (timing.transitionStartedAtMs !== null) {
                logPlaybackClientMetric("player.transition_gap", {
                    durationMs: Math.max(
                        0,
                        nowMs - timing.transitionStartedAtMs,
                    ),
                    trackId,
                    sourceType,
                    outcome: "audible",
                });
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    return { markStartupStabilityWindow, noteStartupProgress };
}
