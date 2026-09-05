import type { Track } from "@/lib/audio-state-context";
import { api } from "@/lib/api";
import {
    hasLocalTrackBacking,
    isRetiredRemoteOnlyTrack,
    resolveTrackProviderSource,
    toTrackRef,
} from "@/lib/trackRef";

/** Build a clean same-origin source URL for a user-selected playable track. */
export function getDeviceDownloadSourceUrl(track: Track): string {
    if (
        !hasLocalTrackBacking(track) &&
        (track.streamSource === "audius" ||
            track.provider?.source === "audius" ||
            track.id.startsWith("audius:"))
    ) {
        throw new Error(
            "Audius доступен только для прослушивания; скачивание не поддерживается",
        );
    }
    if (isRetiredRemoteOnlyTrack(track)) {
        throw new Error("Этот источник больше недоступен для скачивания");
    }
    if (hasLocalTrackBacking(track)) {
        return api.getStreamUrl(track.id);
    }
    const providerSource = resolveTrackProviderSource(track);
    if (providerSource === "youtube" || providerSource === "youtube-direct") {
        const reference = toTrackRef(track);
        if (!("youtubeVideoId" in reference)) {
            throw new Error(
                "Для скачивания YouTube-трека отсутствует video ID",
            );
        }
        return providerSource === "youtube-direct"
            ? api.getYouTubeStreamUrl(reference.youtubeVideoId)
            : api.getYtMusicStreamUrl(
                  reference.youtubeVideoId,
                  undefined,
                  true,
              );
    }
    if (
        !hasLocalTrackBacking(track) &&
        (track.streamSource === "peer" || track.source === "federated")
    ) {
        throw new Error("Удалённый трек нельзя сохранить как локальный файл");
    }
    return api.getStreamUrl(track.id);
}
