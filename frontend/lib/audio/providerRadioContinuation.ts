import type {
    PersonalizedHomeFeed,
    PersonalizedHomeMood,
    PersonalizedTrack,
} from "@/features/home/types";
import type { Track, WaveMode } from "@/lib/audio-state-context";
import {
    appendRecommendationClientContext,
    getRecommendationClientContext,
    getRecommendationSessionId,
    type RecommendationClientContext,
} from "@/lib/recommendationSession";

interface ProviderQueueEntry {
    id: string;
    provider?: {
        source?: string;
        tidalTrackId?: number | null;
        youtubeVideoId?: string | null;
    };
    tidalTrackId?: number;
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

function providerQueueIdentity(track: ProviderQueueEntry): string {
    const videoId = providerVideoId(track);
    if (videoId) return videoId;
    const tidalTrackId = track.provider?.tidalTrackId ?? track.tidalTrackId;
    if (Number.isSafeInteger(tidalTrackId) && Number(tidalTrackId) > 0) {
        return `tidal:${tidalTrackId}`;
    }
    return track.id;
}

/** Identifies a directly playable remote track that can seed provider radio. */
export function isProviderRadioTrack(track: Track): boolean {
    const youtubeTrack =
        (track.streamSource === "youtube" ||
            track.streamSource === "youtube-direct" ||
            track.provider?.source === "youtube") &&
        providerVideoId(track) !== null;
    const tidalTrackId = track.provider?.tidalTrackId ?? track.tidalTrackId;
    const tidalTrack =
        (track.streamSource === "tidal" ||
            track.provider?.source === "tidal") &&
        Number.isSafeInteger(tidalTrackId) &&
        Number(tidalTrackId) > 0;
    return youtubeTrack || tidalTrack;
}

/** Builds one bounded continuation request without allowing the queue in the URL to grow forever. */
export function buildProviderRadioContinuationPath(
    existingQueue: ProviderQueueEntry[],
    cursor: number,
    limit: number,
    mode: WaveMode,
    mood: PersonalizedHomeMood | null = null,
    context: RecommendationClientContext | null = getRecommendationClientContext(),
): string {
    const excludedTrackIds = Array.from(
        new Set(existingQueue.map(providerQueueIdentity).filter(Boolean)),
    ).slice(-MAX_PROVIDER_CONTINUATION_EXCLUSIONS);
    const params = new URLSearchParams({
        limit: String(Math.max(1, Math.min(25, Math.floor(limit)))),
        cursor: String(Math.max(0, Math.floor(cursor))),
        mode,
        surface: "wave",
        sessionId: getRecommendationSessionId(),
    });
    if (mood) params.set("mood", mood);
    appendRecommendationClientContext(params, context);
    if (excludedTrackIds.length > 0) {
        params.set("exclude", excludedTrackIds.join(","));
    }
    return `/personalized/home?${params.toString()}`;
}

/** Converts one personalized provider row to the canonical playback shape. */
export function toProviderPlaybackTrack(
    track: PersonalizedTrack,
    lineageOrIndex?: { generationId?: string; sessionId?: string } | number,
): Track {
    const lineage =
        typeof lineageOrIndex === "object" ? lineageOrIndex : undefined;
    const baseTrack: Track = {
        id: track.id,
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
        ...(lineage?.generationId
            ? { recommendationGenerationId: lineage.generationId }
            : {}),
        ...(lineage?.sessionId
            ? { recommendationSessionId: lineage.sessionId }
            : {}),
    };

    const youtubeVideoId =
        track.youtubeVideoId ?? track.provider.youtubeVideoId;
    if (youtubeVideoId) {
        return {
            ...baseTrack,
            id: `yt:${youtubeVideoId}`,
            source: "youtube",
            provider: { source: "youtube", youtubeVideoId },
            streamSource: "youtube",
            youtubeVideoId,
        };
    }

    const tidalTrackId = track.tidalTrackId ?? track.provider.tidalTrackId;
    if (tidalTrackId !== null && tidalTrackId !== undefined) {
        return {
            ...baseTrack,
            id: `tidal:${tidalTrackId}`,
            source: "tidal",
            provider: { source: "tidal", tidalTrackId },
            streamSource: "tidal",
            tidalTrackId,
        };
    }

    return {
        ...baseTrack,
        source: "local",
        mediaSource: "local",
        provider: { source: "local", providerTrackId: track.id },
    };
}

/** Selects fresh, directly playable continuation rows across provider shelves. */
export function collectProviderRadioContinuation(
    feed: PersonalizedHomeFeed,
    existingQueue: ProviderQueueEntry[],
    limit: number,
): Track[] {
    const excludedTrackIds = new Set(existingQueue.map(providerQueueIdentity));
    const selected: Track[] = [];
    const boundedLimit = Math.max(0, Math.floor(limit));
    const candidates = [
        ...feed.shelves.discovery,
        ...feed.shelves.quickPicks,
        ...feed.shelves.listenAgain,
    ];

    for (const candidate of candidates) {
        const identity = providerQueueIdentity(candidate);
        if (!identity || excludedTrackIds.has(identity)) continue;
        excludedTrackIds.add(identity);
        selected.push(
            toProviderPlaybackTrack(candidate, {
                generationId: feed.generationId,
                sessionId: getRecommendationSessionId(),
            }),
        );
        if (selected.length >= boundedLimit) break;
    }

    return selected;
}
