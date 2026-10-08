import {
    normalizePlaybackRadioOrigin,
    playbackRadioOriginsMatch,
    type PlaybackRadioOrigin,
} from "@soundspan/media-metadata-contract";
import type { Track } from "@/lib/audio-state-context";
import { toProviderPlaybackTrack } from "@/lib/audio/providerRadioContinuation";
import {
    hasNativeMusicSourceIdentity,
    readMusicSourcePlaybackTrack,
} from "@/lib/audio/musicSourcePlayback";

type QueueIdentity = Pick<Track, "id" | "youtubeVideoId" | "provider">;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIBRARY_ID = /^[A-Za-z0-9_][A-Za-z0-9_:-]{0,127}$/;

/** Ordered original-station response; the cursor counts requests, not provider pages. */
export interface OriginalRadioContinuationResponse {
    tracks: unknown[];
    radioOrigin: PlaybackRadioOrigin;
    generationId: string;
    nextCursor: number;
    degraded: boolean;
    degradedSources: string[];
}

/** Bounded original-station request passed through the authenticated API boundary. */
export interface OriginalRadioContinuationRequest {
    origin: PlaybackRadioOrigin;
    queue: readonly QueueIdentity[];
    cursor: number;
    limit: number;
    sessionId: string;
}

function identity(track: QueueIdentity): string | null {
    if (
        (typeof track.id === "string" && /^(vk|yandex):/.test(track.id)) ||
        track.provider?.source === "vk" ||
        track.provider?.source === "yandex"
    ) {
        const source = track.provider?.source,
            id = track.provider?.providerTrackId;
        return (source === "vk" || source === "yandex") &&
            typeof id === "string" &&
            (source === "vk" ? /^-?\d{1,20}_\d{1,20}$/ : /^\d{1,20}$/).test(
                id,
            ) &&
            track.id === `${source}:${id}` &&
            track.youtubeVideoId == null &&
            track.provider?.youtubeVideoId == null &&
            track.provider?.tidalTrackId == null
            ? track.id
            : null;
    }
    const videoId = track.youtubeVideoId ?? track.provider?.youtubeVideoId;
    if (typeof videoId === "string" && VIDEO_ID.test(videoId))
        return `yt:${videoId}`;
    const prefixedVideo = track.id?.startsWith("yt:")
        ? track.id.slice(3)
        : null;
    if (prefixedVideo && VIDEO_ID.test(prefixedVideo))
        return `yt:${prefixedVideo}`;
    return typeof track.id === "string" &&
        LIBRARY_ID.test(track.id) &&
        !/^(yt|radio|tidal|vk|yandex|audius):/.test(track.id)
        ? `library:${track.id}`
        : null;
}

/** Builds the strict radio query without Wave filters or private source metadata. */
export function buildOriginalRadioContinuationPath(
    value: PlaybackRadioOrigin,
    queue: readonly QueueIdentity[],
    cursor: number,
    limit: number,
    sessionId: string,
): string {
    const origin = normalizePlaybackRadioOrigin(value);
    if (!origin) throw new Error("Invalid original radio station");
    if (!sessionId.trim() || sessionId.length > 128)
        throw new Error("Invalid recommendation session");
    const type =
        origin.kind === "artist"
            ? origin.source === "library"
                ? "artist"
                : "artist-name"
            : origin.source === "youtube" ||
                origin.source === "vk" ||
                origin.source === "yandex"
              ? origin.source
              : "vibe";
    const seed = "id" in origin ? origin.id : origin.name;
    const params = new URLSearchParams({
        type,
        value: seed,
        sessionId,
        cursor: String(
            Number.isFinite(cursor)
                ? Math.min(1_000_000, Math.max(0, Math.floor(cursor)))
                : 0,
        ),
        limit: String(
            Number.isFinite(limit)
                ? Math.min(25, Math.max(1, Math.floor(limit)))
                : 25,
        ),
    });
    const exclude = [
        ...new Set(
            queue.map(identity).filter((id): id is string => Boolean(id)),
        ),
    ].slice(-80);
    if (exclude.length) params.set("exclude", exclude.join(","));
    return `/personalized/radio?${params}`;
}

function object(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/** Collects mixed-source membership in server order while retaining station and exposure lineage. */
export function collectOriginalRadioContinuation(
    value: unknown,
    queue: readonly QueueIdentity[],
    requestedOrigin: PlaybackRadioOrigin,
    limit: number,
    sessionId: string,
): Track[] {
    const response = object(value);
    const origin = normalizePlaybackRadioOrigin(requestedOrigin);
    if (
        !response ||
        !origin ||
        !playbackRadioOriginsMatch(origin, response.radioOrigin) ||
        !Array.isArray(response.tracks)
    )
        return [];
    const budget = Number.isFinite(limit)
        ? Math.min(25, Math.max(0, Math.floor(limit)))
        : 0;
    if (!budget) return [];
    const seen = new Set(queue.map(identity).filter(Boolean));
    const selected: Track[] = [];
    for (const value of response.tracks.slice(0, 25)) {
        if (hasNativeMusicSourceIdentity(value)) {
            const track = readMusicSourcePlaybackTrack(value);
            const key = track ? identity(track) : null;
            if (!track || !key || seen.has(key)) continue;
            seen.add(key);
            selected.push({
                ...track,
                radioOrigin: origin,
                ...(typeof response.generationId === "string" &&
                response.generationId.trim() &&
                response.generationId.length <= 128
                    ? { recommendationGenerationId: response.generationId }
                    : {}),
                ...(sessionId.trim() && sessionId.length <= 128
                    ? { recommendationSessionId: sessionId }
                    : {}),
            });
            if (selected.length >= budget) break;
            continue;
        }
        const row = object(value),
            artist = object(row?.artist),
            album = object(row?.album),
            provider = object(row?.provider);
        if (
            !row ||
            !artist ||
            !album ||
            !provider ||
            typeof row.id !== "string" ||
            typeof row.title !== "string" ||
            !row.title.trim() ||
            typeof row.duration !== "number" ||
            !Number.isFinite(row.duration) ||
            row.duration < 0 ||
            typeof artist.name !== "string" ||
            !artist.name.trim() ||
            typeof album.title !== "string" ||
            (row.source !== "library" && row.source !== "youtube") ||
            provider.tidalTrackId != null ||
            row.tidalTrackId != null
        )
            continue;
        const video = row.youtubeVideoId ?? provider.youtubeVideoId;
        const youtube = row.source === "youtube";
        if (
            youtube
                ? typeof video !== "string" ||
                  !VIDEO_ID.test(video) ||
                  (row.youtubeVideoId != null &&
                      provider.youtubeVideoId != null &&
                      row.youtubeVideoId !== provider.youtubeVideoId) ||
                  (/^(yt|radio):/.test(row.id) &&
                      row.id.replace(/^(yt|radio):/, "") !== video)
                : video != null ||
                  !LIBRARY_ID.test(row.id) ||
                  /^(yt|radio|tidal|vk|yandex|audius):/.test(row.id)
        )
            continue;
        const key = youtube ? `yt:${video}` : `library:${row.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const track = toProviderPlaybackTrack(
            {
                id: row.id,
                title: row.title,
                duration: row.duration,
                trackNo:
                    typeof row.trackNo === "number" &&
                    Number.isFinite(row.trackNo)
                        ? row.trackNo
                        : null,
                artist: {
                    name: artist.name,
                    id: typeof artist.id === "string" ? artist.id : null,
                },
                album: {
                    title: album.title,
                    id: typeof album.id === "string" ? album.id : null,
                    coverArt:
                        typeof album.coverArt === "string"
                            ? album.coverArt
                            : null,
                },
                source: youtube ? "youtube" : "library",
                streamSource: youtube ? "youtube" : "library",
                provider: {
                    tidalTrackId: null,
                    youtubeVideoId: youtube ? (video as string) : null,
                },
            },
            {
                generationId:
                    typeof response.generationId === "string" &&
                    response.generationId.length <= 128
                        ? response.generationId
                        : undefined,
                sessionId,
            },
        );
        selected.push({ ...track, radioOrigin: origin });
        if (selected.length >= budget) break;
    }
    return selected;
}
