import type {
    PersonalizedHomeFeed,
    PersonalizedHomeMood,
    PersonalizedTrack,
} from "@/features/home/types";
import type { Track, WaveMode } from "@/lib/audio-state-context";

interface ProviderQueueEntry {
    id: string;
    provider?: Track["provider"];
    youtubeVideoId?: string;
}

const MAX_PROVIDER_CONTINUATION_EXCLUSIONS = 80;

function providerVideoId(track: ProviderQueueEntry): string | null {
    const candidate =
        track.provider?.youtubeVideoId ?? track.youtubeVideoId ?? null;
    return typeof candidate === "string" && candidate.trim().length > 0
        ? candidate.trim()
        : null;
}

/** Identifies a remote YouTube track that can seed provider radio. */
export function isProviderRadioTrack(track: Track): boolean {
    return (
        (track.streamSource === "youtube" ||
            track.streamSource === "youtube-direct" ||
            track.provider?.source === "youtube") &&
        providerVideoId(track) !== null
    );
}

/** Builds one bounded continuation request without allowing the queue in the URL to grow forever. */
export function buildProviderRadioContinuationPath(
    existingQueue: ProviderQueueEntry[],
    cursor: number,
    limit: number,
    mode: WaveMode,
    mood: PersonalizedHomeMood | null = null,
): string {
    const excludedVideoIds = Array.from(
        new Set(
            existingQueue
                .map(providerVideoId)
                .filter((videoId): videoId is string => videoId !== null),
        ),
    ).slice(-MAX_PROVIDER_CONTINUATION_EXCLUSIONS);
    const params = new URLSearchParams({
        limit: String(Math.max(1, Math.min(25, Math.floor(limit)))),
        cursor: String(Math.max(0, Math.floor(cursor))),
        mode,
    });
    if (mood) params.set("mood", mood);
    if (excludedVideoIds.length > 0) {
        params.set("exclude", excludedVideoIds.join(","));
    }
    return `/personalized/home?${params.toString()}`;
}

/** Converts one personalized provider row to the canonical playback shape. */
export function toProviderPlaybackTrack(track: PersonalizedTrack): Track {
    const youtubeVideoId =
        track.youtubeVideoId || track.provider.youtubeVideoId;
    return {
        id: `yt:${youtubeVideoId}`,
        title: track.title,
        artist: {
            name: track.artist.name,
            ...(track.artist.id ? { id: track.artist.id } : {}),
        },
        album: {
            title: track.album.title,
            coverArt: track.album.coverArt,
            ...(track.album.id ? { id: track.album.id } : {}),
        },
        duration: track.duration,
        source: "youtube",
        provider: {
            source: "youtube",
            youtubeVideoId,
        },
        streamSource: "youtube",
        youtubeVideoId,
    };
}

/** Selects fresh, directly playable continuation rows across provider shelves. */
export function collectProviderRadioContinuation(
    feed: PersonalizedHomeFeed,
    existingQueue: ProviderQueueEntry[],
    limit: number,
): Track[] {
    const excludedVideoIds = new Set(
        existingQueue
            .map(providerVideoId)
            .filter((videoId): videoId is string => videoId !== null),
    );
    const selected: Track[] = [];
    const boundedLimit = Math.max(0, Math.floor(limit));
    const candidates = [
        ...feed.shelves.discovery,
        ...feed.shelves.quickPicks,
        ...feed.shelves.listenAgain,
    ];

    for (const candidate of candidates) {
        const videoId = (
            candidate.youtubeVideoId || candidate.provider.youtubeVideoId
        ).trim();
        if (!videoId || excludedVideoIds.has(videoId)) continue;
        excludedVideoIds.add(videoId);
        selected.push(toProviderPlaybackTrack(candidate));
        if (selected.length >= boundedLimit) break;
    }

    return selected;
}
