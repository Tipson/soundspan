import type { Track } from "@/lib/audio-state-context";
import { api } from "@/lib/api";

/** Build a clean same-origin source URL for a user-selected playable track. */
export function getDeviceDownloadSourceUrl(track: Track): string {
    if (track.streamSource === "tidal" && track.tidalTrackId) {
        return api.getTidalStreamUrl(track.tidalTrackId);
    }
    if (track.streamSource === "youtube" && track.youtubeVideoId) {
        return api.getYtMusicStreamUrl(track.youtubeVideoId, undefined, true);
    }
    if (track.streamSource === "youtube-direct" && track.youtubeVideoId) {
        return api.getYouTubeStreamUrl(track.youtubeVideoId);
    }
    return api.getStreamUrl(track.id);
}
