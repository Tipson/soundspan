import { api } from "@/lib/api";
import type { Track } from "@/lib/audio-state-context";
import { withPlaybackRadioOrigin } from "./playbackRadioOrigin";
import { getRecommendationSessionId } from "@/lib/recommendationSession";
import {
    hasNativeMusicSourceIdentity,
    readMusicSourcePlaybackTrack,
} from "@/lib/audio/musicSourcePlayback";
import { collectOriginalRadioContinuation } from "./originalRadioContinuation";
import {
    isRemoteTrack,
    isRetiredRemoteOnlyTrack,
    normalizeActionableAudioTrack,
} from "@/lib/trackRef";

/** Explains when a provider has no supported track-radio seed API. */
export class UnsupportedTrackRadioError extends Error {
    constructor() {
        super(
            "Радио доступно для локальных треков и YouTube. Для этого источника подбор пока недоступен.",
        );
    }
}

/** Native action eligibility uses the exact recording; legacy artist actions retain their availability explanation. */
export function canLoadTrackRadio(seed: Track): boolean {
    if (hasNativeMusicSourceIdentity(seed))
        return readMusicSourcePlaybackTrack(seed) !== null;
    if (seed.artist?.id) return true;
    if (isRetiredRemoteOnlyTrack(seed))
        return Boolean(seed.artist?.name?.trim());
    const normalized = normalizeActionableAudioTrack(seed);
    return Boolean(
        normalized && (normalized.youtubeVideoId || !isRemoteTrack(normalized)),
    );
}

/** Loads a track-seeded queue, excluding seed aliases and unplayable rows. */
export async function loadTrackRadio(seed: Track): Promise<Track[]> {
    if (hasNativeMusicSourceIdentity(seed)) {
        const native = readMusicSourcePlaybackTrack(seed);
        if (!native?.musicSourceRecording) return [];
        const recording = native.musicSourceRecording,
            origin = {
                kind: "track",
                source: recording.provider,
                id: recording.id,
            } as const,
            sessionId = getRecommendationSessionId();
        const response = await api.getRadioContinuation({
            origin,
            queue: [native],
            cursor: 0,
            limit: 25,
            sessionId,
        });
        return collectOriginalRadioContinuation(
            response,
            [native],
            origin,
            25,
            sessionId,
        );
    }
    const normalizedSeed = normalizeActionableAudioTrack(seed);
    // Retired catalog entries retain artist-radio navigation without adding
    // their unplayable recording to the queue.
    if (isRetiredRemoteOnlyTrack(seed) && seed.artist?.name?.trim()) {
        const response = await api.getRadioTracks(
            "artist-name",
            seed.artist.name,
        );
        return normalizeRadioTracks(response.tracks ?? [], [seed]).map(
            (track) =>
                withPlaybackRadioOrigin(track, {
                    kind: "artist",
                    source: "discovery",
                    name: seed.artist.name,
                }),
        );
    }
    if (!normalizedSeed) return [];
    const videoId = normalizedSeed.youtubeVideoId;
    if (!videoId && isRemoteTrack(normalizedSeed))
        throw new UnsupportedTrackRadioError();
    const response = await api.getRadioTracks(
        videoId ? "youtube" : "vibe",
        videoId || seed.id,
    );
    return normalizeRadioTracks(response.tracks ?? [], [normalizedSeed]).map(
        (track) =>
            withPlaybackRadioOrigin(track, {
                kind: "track",
                source: videoId ? "youtube" : "library",
                id: videoId || seed.id,
            }),
    );
}

/** Preserves provider identities while rejecting malformed or duplicate radio rows. */
export function normalizeRadioTracks(
    candidates: unknown[],
    excluded: Track[] = [],
): Track[] {
    const keyFor = (track: Track) =>
        track.youtubeVideoId ? `yt:${track.youtubeVideoId}` : track.id;
    const seen = new Set(excluded.map(keyFor));
    return candidates.flatMap((value) => {
        const candidate = value as Partial<Track> | null;
        if (
            !candidate ||
            typeof candidate !== "object" ||
            typeof candidate.title !== "string" ||
            typeof candidate.duration !== "number" ||
            typeof candidate.artist?.name !== "string" ||
            typeof candidate.album?.title !== "string"
        )
            return [];
        const track = normalizeActionableAudioTrack(candidate as Track);
        if (!track) return [];
        const key = track.youtubeVideoId
            ? `yt:${track.youtubeVideoId}`
            : track.id;
        if (seen.has(key)) return [];
        seen.add(key);
        return [track];
    });
}
