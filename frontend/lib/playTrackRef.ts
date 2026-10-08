import type { Track } from "./audio-state-context";
import { musicSourceCandidateSchema } from "./audio/musicSourcePlayback";
import type { MusicSourceCandidate } from "./api/musicSources";
import { toAddToPlaylistRef, type AddToPlaylistRef } from "./trackRef";

/** References accepted by private play history, independently of playlist writes. */
export type PlayTrackRef =
    | AddToPlaylistRef
    | { musicSourceRecording: MusicSourceCandidate };

/** Preserve exact direct recordings without treating them as library or YouTube rows. */
export function toPlayTrackRef(track: Track): PlayTrackRef {
    if (
        /^(vk|yandex):/.test(track.id) ||
        track.provider?.source === "vk" ||
        track.provider?.source === "yandex" ||
        track.mediaSource === "vk" ||
        track.mediaSource === "yandex" ||
        track.streamSource === "vk" ||
        track.streamSource === "yandex"
    ) {
        const recording = musicSourceCandidateSchema.parse(
            track.musicSourceRecording,
        );
        if (
            track.id !== `${recording.provider}:${recording.id}` ||
            track.provider?.providerTrackId !== recording.id ||
            [
                track.provider?.source,
                track.mediaSource,
                track.streamSource,
                track.source,
            ].some(
                (source) =>
                    source !== undefined && source !== recording.provider,
            ) ||
            ("hasLocalFile" in track && track.hasLocalFile === true) ||
            Boolean(track.filePath)
        ) {
            throw new Error(
                "Direct play recording conflicts with track identity",
            );
        }
        return { musicSourceRecording: recording };
    }
    return toAddToPlaylistRef(track);
}
