import { z } from "zod";
import type { MusicSourceTrack } from "../musicSources/types";
import type { RecommendationCandidate } from "./types";

const recordingSchema = z
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

/** Detect reserved native identity even when an inconsistent caller labels it as legacy. */
export function hasNativeRecommendationIdentity(
    candidate: RecommendationCandidate,
): boolean {
    return (
        candidate.source === "vk" ||
        candidate.source === "yandex" ||
        candidate.streamSource === "vk" ||
        candidate.streamSource === "yandex" ||
        candidate.provider?.source === "vk" ||
        candidate.provider?.source === "yandex" ||
        candidate.musicSourceRecording != null ||
        /^(vk|yandex):/.test(candidate.id)
    );
}

/** Validate a native candidate's exact tuple; reserved sources never fall through to legacy identity. */
export function readNativeRecommendationRecording(
    candidate: RecommendationCandidate,
): MusicSourceTrack | null {
    const parsed = recordingSchema.safeParse(candidate.musicSourceRecording);
    if (!parsed.success) return null;
    const recording = parsed.data;
    if (
        candidate.source !== recording.provider ||
        candidate.streamSource !== recording.provider ||
        candidate.id !== `${recording.provider}:${recording.id}` ||
        candidate.provider?.source !== recording.provider ||
        candidate.provider?.providerTrackId !== recording.id ||
        candidate.provider?.youtubeVideoId != null ||
        candidate.provider?.tidalTrackId != null ||
        candidate.youtubeVideoId != null ||
        candidate.tidalTrackId != null ||
        candidate.title !== recording.title ||
        candidate.artist?.name !== recording.artists.join(", ") ||
        candidate.duration !== recording.duration
    )
        return null;
    return recording;
}

/** Construct a safe upstream candidate without claiming byte-probe attestation or cross-source equivalence. */
export function toNativeRecommendationCandidate(
    value: unknown,
    origin: string,
): RecommendationCandidate | null {
    const parsed = recordingSchema.safeParse(value);
    if (!parsed.success) return null;
    const recording = parsed.data;
    return {
        id: `${recording.provider}:${recording.id}`,
        canonicalKey: `provider:${recording.provider}:${recording.id}`,
        canonicalRecordingId: null,
        title: recording.title,
        duration: recording.duration,
        trackNo: null,
        artist: { id: null, name: recording.artists.join(", ") },
        album: { id: null, title: "", coverArt: null },
        source: recording.provider,
        streamSource: recording.provider,
        provider: {
            source: recording.provider,
            providerTrackId: recording.id,
            tidalTrackId: null,
            youtubeVideoId: null,
        },
        musicSourceRecording: recording,
        candidateSources: [origin],
        providerPrior: 1,
        lane: "discovery",
    };
}
