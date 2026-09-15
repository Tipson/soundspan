import type { Track } from "@/lib/audio-state-context";
import { acquireDeviceOfflinePlaybackSource } from "@/features/device-offline/playbackResolver";
import type { PlaybackSourceLeaseController } from "./playbackSourceLeaseController";
import { api } from "@/lib/api";
import { getAuthRuntimeLease } from "@/lib/auth-runtime-generation";

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
        .acquire(async (signal) => {
            if (
                track.playbackSourcePolicy !== "device-only" &&
                (track.streamSource === "audius" ||
                    track.provider?.source === "audius" ||
                    track.id.startsWith("audius:"))
            ) {
                const id = track.provider?.providerTrackId;
                if (!id || track.id !== `audius:${id}`)
                    throw new Error("Некорректная запись Audius");
                const auth = getAuthRuntimeLease();
                const combined = AbortSignal.any([signal, auth.signal]);
                const url = await api.resolveAudiusPlayback(id, combined);
                if (combined.aborted)
                    throw new DOMException(
                        "Authentication or playback changed",
                        "AbortError",
                    );
                return { url, release() {} };
            }
            return acquireDeviceOfflinePlaybackSource(
                track,
                networkUrl,
                signal,
            );
        }, isCurrent)
        .then(
            (resolvedUrl) => {
                if (resolvedUrl) onReady(resolvedUrl);
            },
            (error) => {
                if (isCurrent()) onError(error);
            },
        );
}
