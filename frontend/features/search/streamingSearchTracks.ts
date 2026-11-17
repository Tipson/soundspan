import type { DiscoverResult } from "./types";
import {
    hasNativeMusicSourceIdentity,
    readMusicSourcePlaybackTrack,
} from "@/lib/audio/musicSourcePlayback";

const videoId = /^[A-Za-z0-9_-]{11}$/;
function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/** Reuse exact saved-track identities; no fuzzy lookup or album identity is inferred. */
export function toStreamingSearchTracks(value: unknown): DiscoverResult[] {
    if (!Array.isArray(value)) return [];
    const result: DiscoverResult[] = [];
    const seen = new Set<string>();
    for (const raw of value) {
        const row = object(raw);
        if (!row) continue;
        let track: DiscoverResult;
        if (hasNativeMusicSourceIdentity(row)) {
            const exact = readMusicSourcePlaybackTrack(row);
            if (!exact?.musicSourceRecording) continue;
            track = {
                type: "track",
                id: exact.id,
                name: exact.title,
                artist: exact.artist.name,
                duration: exact.duration,
                musicSourceRecording: exact.musicSourceRecording,
            };
        } else {
            const artist = object(row.artist),
                album = object(row.album);
            const provider = object(row.provider);
            const id = row.youtubeVideoId;
            if (
                row.source !== "youtube" ||
                row.streamSource !== "youtube" ||
                typeof id !== "string" ||
                !videoId.test(id) ||
                row.id !== `yt:${id}` ||
                typeof row.title !== "string" ||
                !row.title.trim() ||
                typeof artist?.name !== "string" ||
                !artist.name.trim() ||
                typeof row.duration !== "number" ||
                !Number.isFinite(row.duration) ||
                row.duration < 0 ||
                row.tidalTrackId != null ||
                provider?.tidalTrackId != null ||
                (provider?.youtubeVideoId != null &&
                    provider.youtubeVideoId !== id)
            )
                continue;
            track = {
                type: "track",
                id: `yt:${id}`,
                name: row.title,
                artist: artist.name,
                duration: row.duration,
                album:
                    typeof album?.title === "string" ? album.title : undefined,
                image:
                    typeof album?.coverArt === "string"
                        ? album.coverArt
                        : undefined,
                streamSource: "youtube",
                youtubeVideoId: id,
            };
        }
        if (seen.has(track.id!)) continue;
        seen.add(track.id!);
        result.push(track);
    }
    return result;
}

function identity(row: DiscoverResult): string | null {
    return row.musicSourceRecording
        ? `${row.musicSourceRecording.provider}:${row.musicSourceRecording.id}`
        : row.streamSource === "youtube" &&
            row.youtubeVideoId &&
            videoId.test(row.youtubeVideoId)
          ? `yt:${row.youtubeVideoId}`
          : null;
}

/** Suppress only duplicates actually visible in the personal group, preserving other versions. */
export function excludeVisibleStreamingMatches(
    rows: readonly DiscoverResult[],
    visible: readonly DiscoverResult[],
): DiscoverResult[] {
    const seen = new Set(visible.map(identity).filter((id) => id !== null));
    return rows.flatMap((row) => {
        const versions = row.versions ?? [row];
        const remaining = versions.filter((version) => {
            const key = identity(version);
            return key === null || !seen.has(key);
        });
        if (remaining.length === versions.length) return [row];
        if (!remaining.length) return [];
        const first = { ...remaining[0] };
        delete first.versions;
        return [
            {
                ...first,
                ...(remaining.length > 1 ? { versions: remaining } : {}),
            },
        ];
    });
}
