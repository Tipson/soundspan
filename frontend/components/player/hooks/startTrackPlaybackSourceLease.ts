import type { Track } from "@/lib/audio-state-context";
import { acquireDeviceOfflinePlaybackSource } from "@/features/device-offline/playbackResolver";
import type { PlaybackSourceLeaseController } from "./playbackSourceLeaseController";

interface StartTrackPlaybackSourceLeaseOptions {
    controller: PlaybackSourceLeaseController;
    track: Track;
    networkUrl: string;
    isCurrent(): boolean;
    onReady(url: string): void;
    onError(error: unknown): void;
}

/** Resolve one track source and pass only the current lease to the audio engine. */
export function startTrackPlaybackSourceLease({
    controller,
    track,
    networkUrl,
    isCurrent,
    onReady,
    onError,
}: StartTrackPlaybackSourceLeaseOptions): void {
    void controller
        .acquire(
            (signal) =>
                acquireDeviceOfflinePlaybackSource(track, networkUrl, signal),
            isCurrent,
        )
        .then(
            (resolvedUrl) => {
                if (resolvedUrl) onReady(resolvedUrl);
            },
            (error) => {
                if (isCurrent()) onError(error);
            },
        );
}
