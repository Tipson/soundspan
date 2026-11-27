import type { Track } from "@/lib/audio-state-context";
import {
    acquireDeviceOfflinePlaybackSource,
    hasDeviceOfflinePlaybackCopy,
} from "@/features/device-offline/playbackResolver";
import type {
    PlaybackSourceLease,
    PlaybackSourceLeaseController,
} from "./playbackSourceLeaseController";
import { api } from "@/lib/api";
import { getAuthRuntimeLease } from "@/lib/auth-runtime-generation";
import { musicSourceCandidateSchema } from "@/lib/audio/musicSourcePlayback";
import { trackAudioTarget } from "@/lib/audio/trackAudioVersions";

interface StartTrackPlaybackSourceLeaseOptions {
    controller: PlaybackSourceLeaseController;
    track: Track;
    networkUrl: string;
    preparedSource?: PlaybackSourceLease | null;
    allowPublished?: boolean;
    isCurrent(): boolean;
    onReady(url: string): void;
    onError(error: unknown): void;
}

/** Resolve one track source and pass only the current lease to the audio engine. */
export function startTrackPlaybackSourceLease({
    controller,
    track,
    networkUrl,
    preparedSource,
    allowPublished = true,
    isCurrent,
    onReady,
    onError,
}: StartTrackPlaybackSourceLeaseOptions): void {
    void controller
        .acquire(async (signal) => {
            let prepared = preparedSource;
            try {
                const target =
                    allowPublished &&
                    track.playbackSourcePolicy !== "device-only" &&
                    (typeof navigator === "undefined" ||
                        navigator.onLine !== false)
                        ? trackAudioTarget(track)
                        : null;
                if (target) {
                    const combined = AbortSignal.any([
                        signal,
                        getAuthRuntimeLease().signal,
                    ]);
                    let publishedUrl: string | null = null;
                    try {
                        publishedUrl = await api.getPublishedTrackAudioUrl(
                            target,
                            combined,
                        );
                    } catch {
                        // Optional source lookup must not strand standard playback.
                    }
                    combined.throwIfAborted();
                    if (publishedUrl)
                        return { url: publishedUrl, release() {} };
                }
                if (prepared) {
                    const source = prepared;
                    prepared = null;
                    return source;
                }
            } finally {
                prepared?.release();
            }
            if (
                track.playbackSourcePolicy !== "device-only" &&
                (track.streamSource === "vk" || track.streamSource === "yandex")
            ) {
                const recording = musicSourceCandidateSchema.parse(
                    track.musicSourceRecording,
                );
                if (
                    recording.provider !== track.streamSource ||
                    track.id !== `${recording.provider}:${recording.id}` ||
                    track.provider?.providerTrackId !== recording.id
                )
                    throw new Error("Некорректная запись каталога");
                const combined = AbortSignal.any([
                    signal,
                    getAuthRuntimeLease().signal,
                ]);
                if (hasDeviceOfflinePlaybackCopy(track))
                    return acquireDeviceOfflinePlaybackSource(
                        track,
                        api.getMusicSourceStreamUrl(
                            recording.provider,
                            recording.id,
                        ),
                        combined,
                    );
                const url = await api.resolveMusicSourcePlayback(
                    recording,
                    combined,
                );
                combined.throwIfAborted();
                return { url, release() {} };
            }
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
