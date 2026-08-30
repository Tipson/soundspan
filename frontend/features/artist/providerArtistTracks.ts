import type { Track } from "./types";

export interface ProviderAlbumTrackPayload {
    browseId?: string | null;
    title?: string | null;
    artist?: string | null;
    coverUrl?: string | null;
    tracks?: Array<{
        videoId?: string | null;
        title?: string | null;
        artist?: string | null;
        trackNumber?: number | null;
        duration?: number | string | null;
        duration_seconds?: number | null;
    }> | null;
}

const durationSeconds = (track: {
    duration?: number | string | null;
    duration_seconds?: number | null;
}): number => {
    if (
        typeof track.duration_seconds === "number" &&
        Number.isFinite(track.duration_seconds) &&
        track.duration_seconds >= 0
    ) {
        return Math.round(track.duration_seconds);
    }
    if (typeof track.duration === "number" && track.duration >= 0) {
        return Math.round(track.duration);
    }
    if (typeof track.duration !== "string") return 0;
    const parts = track.duration.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
};

/** Flatten loaded provider releases into one ordered, playable artist catalog. */
export function mergeProviderAlbumTracks(
    albums: ProviderAlbumTrackPayload[],
): Track[] {
    const seenVideoIds = new Set<string>();
    const merged: Track[] = [];

    for (const album of albums) {
        const browseId = album.browseId?.trim() || undefined;
        const albumTitle = album.title?.trim() || "YouTube Music";
        for (const track of album.tracks ?? []) {
            const videoId = track.videoId?.trim();
            const title = track.title?.trim();
            if (!videoId || !title || seenVideoIds.has(videoId)) continue;
            seenVideoIds.add(videoId);
            const artistName = track.artist?.trim() || album.artist?.trim();
            merged.push({
                id: `yt:${videoId}`,
                title,
                duration: durationSeconds(track),
                trackNo: track.trackNumber ?? undefined,
                album: {
                    id: browseId,
                    title: albumTitle,
                    coverArt: album.coverUrl ?? undefined,
                },
                artist: artistName ? { name: artistName } : undefined,
                streamSource: "youtube",
                youtubeVideoId: videoId,
                source: "youtube",
            });
        }
    }

    return merged;
}

/** Advance one visible release batch while retaining a bounded request fan-out. */
export function advanceProviderReleaseCount(
    current: number,
    total: number,
    batchSize: number,
): number {
    return Math.min(Math.max(0, total), Math.max(0, current) + batchSize);
}
