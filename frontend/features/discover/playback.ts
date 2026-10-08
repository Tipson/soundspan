import type { Track } from "@/lib/audio-state-context";
import {
    hasNativeMusicSourceIdentity,
    readMusicSourcePlaybackTrack,
} from "@/lib/audio/musicSourcePlayback";
import type { DiscoverTrack } from "./types";

/** Reserve native claims before any legacy local/YouTube matching fallback. */
export function hasNativeDiscoverIdentity(track: DiscoverTrack): boolean {
    return (
        track.sourceType === "vk" ||
        track.sourceType === "yandex" ||
        hasNativeMusicSourceIdentity(track)
    );
}

/** Map a flat Discover row to a portable queue item; conflicting native tuples fail closed. */
export function mapDiscoverTrackToPlaybackTrack(
    track: DiscoverTrack,
): Track | null {
    if (hasNativeDiscoverIdentity(track)) {
        if (
            (track.sourceType !== "vk" && track.sourceType !== "yandex") ||
            track.streamSource !== track.sourceType
        )
            return null;
        const native = readMusicSourcePlaybackTrack({
            ...track,
            source:
                track.source === undefined ? track.sourceType : track.source,
            artist: { name: track.artist },
        });
        return native
            ? {
                  ...native,
                  ...(track.recommendationGenerationId && {
                      recommendationGenerationId:
                          track.recommendationGenerationId,
                      recommendationQueueMode: "finite" as const,
                  }),
              }
            : null;
    }
    return {
        id: track.id,
        title: track.title,
        artist: { name: track.artist, id: track.artistId ?? undefined },
        album: {
            id: track.albumId,
            title: track.album,
            coverArt: track.coverUrl || undefined,
            albumLoudnessLufs: track.albumLoudnessLufs ?? null,
            albumTruePeakDb: track.albumTruePeakDb ?? null,
        },
        duration: track.duration || 0,
        loudnessLufs: track.loudnessLufs ?? null,
        truePeakDb: track.truePeakDb ?? null,
        ...(track.recommendationGenerationId && {
            recommendationGenerationId: track.recommendationGenerationId,
            recommendationQueueMode: "finite" as const,
        }),
        ...(track.streamSource === "tidal" &&
            track.tidalTrackId && {
                streamSource: "tidal" as const,
                tidalTrackId: track.tidalTrackId,
            }),
        ...(track.streamSource === "youtube" &&
            track.youtubeVideoId && {
                streamSource: "youtube" as const,
                youtubeVideoId: track.youtubeVideoId,
            }),
    };
}
