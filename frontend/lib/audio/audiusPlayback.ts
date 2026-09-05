import { z } from "zod";
import { isAllowedAudiusStreamUrl } from "@soundspan/media-metadata-contract";
import type { Track } from "../audio-state-context";

/** Public full-stream metadata; a provider identity, never a cross-catalog match. */
export const audiusTrackSchema = z.object({
    source: z.literal("audius"),
    id: z.string().regex(/^[A-Za-z0-9]{3,32}$/),
    title: z.string().trim().min(1).max(300),
    artist: z.string().trim().min(1).max(200),
    artistHandle: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
    artistVerified: z.boolean(),
    durationSeconds: z.number().positive().max(86_400),
    attributionUrl: z
        .string()
        .max(650)
        .regex(/^https:\/\/audius\.co\/[A-Za-z0-9_.-]+\/[^\s?#\\]+$/),
    fullStreamAvailable: z.literal(true),
    automaticFallbackEligible: z.literal(false),
    downloadAllowed: z.literal(false),
});

/** Source-labelled Audius catalog row accepted by the browser API. */
export type AudiusCatalogTrack = z.infer<typeof audiusTrackSchema>;

/** Convert validated search metadata into the existing player/queue contract. */
export function toAudiusPlaybackTrack(value: unknown): Track {
    const track = audiusTrackSchema.parse(value);
    return {
        id: `audius:${track.id}`,
        title: track.title,
        artist: { name: track.artist },
        album: { title: "Audius" },
        duration: track.durationSeconds,
        mediaSource: "audius",
        source: "audius",
        streamSource: "audius",
        provider: { source: "audius", providerTrackId: track.id },
        sourcePageUrl: track.attributionUrl,
    };
}

/** A resolved public URL must not carry Soundspan credentials or change recordings. */
export function validateAudiusPlaybackUrl(id: string, value: unknown): string {
    if (!/^[A-Za-z0-9]{3,32}$/.test(id))
        throw new Error("Некорректный трек Audius");
    const parsed = z
        .object({
            source: z.literal("audius"),
            trackId: z.literal(id),
            streamUrl: z.string(),
        })
        .parse(value);
    if (!isAllowedAudiusStreamUrl(parsed.streamUrl))
        throw new Error("Audius вернул недопустимый адрес воспроизведения");
    return parsed.streamUrl;
}
