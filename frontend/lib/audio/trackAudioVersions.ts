import type { Track } from "../audio-state-context";
import { resolveTrackProviderSource } from "../trackRef";

/** Exact identity used by the track-audio publication route. */
export interface TrackAudioTarget {
    source: "library" | "youtube" | "vk" | "yandex";
    trackId: string;
}

const nativeIds = {
    vk: /^-?\d{1,20}_\d{1,20}$/,
    yandex: /^\d{1,20}$/,
};

/** Use the effective catalog route, independently of title or artist names. */
export function trackAudioTarget(track: Track): TrackAudioTarget | null {
    const source = track.streamSource ?? resolveTrackProviderSource(track);
    if (source === "vk" || source === "yandex") {
        const id = track.provider?.providerTrackId;
        return id &&
            nativeIds[source].test(id) &&
            track.id === `${source}:${id}`
            ? { source, trackId: id }
            : null;
    }
    if (source === "youtube" || source === "youtube-direct") {
        const id = track.youtubeVideoId;
        return id && /^[A-Za-z0-9_-]{11}$/.test(id)
            ? { source: "youtube", trackId: id }
            : null;
    }
    if (
        (source === null || source === "local" || source === "peer") &&
        /^[A-Za-z0-9_-]{1,256}$/.test(track.id)
    ) {
        return { source: "library", trackId: track.id };
    }
    return null;
}

const versionId =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const streamPrefix = "/api/track-audio/versions/";

/** Build a same-origin URL from a validated immutable version id. */
export function trackAudioStreamUrl(id: unknown): string | null {
    return typeof id === "string" && versionId.test(id)
        ? `${streamPrefix}${id}/stream`
        : null;
}

/** Recognize version streams for engine codec selection. */
export function isTrackAudioStreamUrl(url: string): boolean {
    if (!url.startsWith(streamPrefix) || !url.endsWith("/stream")) return false;
    return versionId.test(url.slice(streamPrefix.length, -"/stream".length));
}
