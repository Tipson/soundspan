import { z } from "zod";
import type { Track } from "../audio-state-context";

/** Strict public metadata only; signed stream URLs never enter persisted queue state. */
export const musicSourceCandidateSchema = z
    .object({
        provider: z.enum(["vk", "yandex"]),
        id: z.string().min(1).max(42),
        title: z.string().trim().min(1).max(200),
        artists: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
        duration: z.number().positive().max(3600),
        contentVersion: z.enum(["explicit", "clean", "unknown"]),
        preview: z.literal(false),
        isrc: z
            .string()
            .regex(/^[A-Za-z]{2}[A-Za-z0-9]{3}\d{7}$/)
            .optional(),
    })
    .refine((track) =>
        (track.provider === "vk" ? /^-?\d{1,20}_\d{1,20}$/ : /^\d{1,20}$/).test(
            track.id,
        ),
    );

/** Construct a portable exact recording, retaining the full artist list for revalidation. */
export function toMusicSourcePlaybackTrack(value: unknown): Track {
    const recording = musicSourceCandidateSchema.parse(value);
    return {
        id: `${recording.provider}:${recording.id}`,
        title: recording.title,
        artist: { name: recording.artists.join(", ") },
        album: { title: "" },
        duration: recording.duration,
        mediaSource: recording.provider,
        streamSource: recording.provider,
        source: recording.provider,
        provider: { source: recording.provider, providerTrackId: recording.id },
        musicSourceRecording: recording,
    };
}
