import { z } from "zod";

/** Bounded public metadata claimed for an owner's private play, never an attested catalog row. */
export const musicSourcePlayRecordingSchema = z
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
    .refine((recording) =>
        (recording.provider === "vk"
            ? /^-?\d{1,20}_\d{1,20}$/
            : /^\d{1,20}$/
        ).test(recording.id),
    );

/** Project bounded saved metadata, independently of shared verified catalog metadata. */
export function normalizeMusicSourceRecordingSnapshot(
    snapshot: unknown,
    namespace?: { provider: string; providerTrackId: string } | null,
) {
    const parsed = musicSourcePlayRecordingSchema.safeParse(snapshot);
    if (!parsed.success) return null;
    const recording = parsed.data;
    if (
        namespace &&
        (namespace.provider !== recording.provider ||
            namespace.providerTrackId !== recording.id)
    )
        return null;
    return {
        id: `${recording.provider}:${recording.id}`,
        title: recording.title,
        displayTitle: null,
        duration: recording.duration,
        trackNo: null,
        filePath: null,
        source: recording.provider,
        mediaSource: recording.provider,
        streamSource: recording.provider,
        provider: {
            source: recording.provider,
            providerTrackId: recording.id,
            youtubeVideoId: null,
            tidalTrackId: null,
        },
        artist: { id: null, name: recording.artists.join(", ") },
        album: {
            id: null,
            title: "",
            coverArt: null,
            artist: { id: null, name: recording.artists.join(", ") },
        },
        musicSourceRecording: recording,
    };
}

/** Project only the owner's play snapshot and preserve its exact listen-source fence. */
export function normalizeMusicSourcePlaySnapshot(play: {
    source: string;
    musicSourceRecording?: unknown;
    trackMusicSource?: { provider: string; providerTrackId: string } | null;
}) {
    const normalized = normalizeMusicSourceRecordingSnapshot(
        play.musicSourceRecording,
        play.trackMusicSource,
    );
    if (
        !normalized ||
        play.source !== (normalized.source === "vk" ? "VK" : "YANDEX")
    )
        return null;
    return normalized;
}
