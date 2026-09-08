import axios from "axios";
import { z } from "zod";
import { BRAND_USER_AGENT } from "../../config/brand";
import {
    classifyRecordingLanguage,
    type LanguageRecording,
    type RecordingLanguage,
} from "./recordingLanguage";

const lyricsSchema = z.object({
    trackName: z.string().max(1000),
    artistName: z.string().max(1000),
    duration: z.number().finite().positive(),
    instrumental: z.boolean(),
    plainLyrics: z.string().max(64_000).nullable(),
    syncedLyrics: z.string().max(96_000).nullable(),
});

function titleForLookup(title: string): string {
    return title
        .replace(
            /[([]\s*(?:official\s+(?:(?:music|lyric)\s+)?(?:video|audio)|lyrics?|audio)\s*[)\]]/gi,
            "",
        )
        .trim();
}
function normalize(value: string): string {
    return value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

/** Only matched recording lyrics can supply vocal-language evidence. */
export function classifyMatchedLyrics(
    track: LanguageRecording,
    value: unknown,
): RecordingLanguage {
    const parsed = lyricsSchema.safeParse(value);
    if (!parsed.success) return "unknown";
    const lyrics = parsed.data;
    if (
        normalize(lyrics.artistName) !== normalize(track.artist.name) ||
        normalize(lyrics.trackName) !==
            normalize(titleForLookup(track.title)) ||
        Math.abs(lyrics.duration - track.duration) > 3
    )
        return "unknown";
    return classifyRecordingLanguage(lyrics);
}

/** One bounded, non-retrying public metadata request; lyrics never leave this adapter. */
export async function lookupRecordingLanguage(
    track: LanguageRecording,
): Promise<RecordingLanguage> {
    if (
        !track.title.trim() ||
        !track.artist.name.trim() ||
        !Number.isFinite(track.duration) ||
        track.duration <= 0 ||
        track.duration >= 1800
    )
        return "unknown";
    const response = await axios.get<unknown>("https://lrclib.net/api/get", {
        params: {
            // A recording may belong to a single, compilation or album edition
            // with different metadata. Match vocals by artist, exact versioned
            // title and duration; an album restriction can hide the same song.
            artist_name: track.artist.name,
            track_name: titleForLookup(track.title),
            duration: Math.round(track.duration),
        },
        headers: { "User-Agent": BRAND_USER_AGENT },
        // This fixed public metadata origin is reachable directly. The
        // deployment's media HTTPS proxy times out for LRCLIB; never change
        // process-wide proxy defaults or other providers' routing here.
        proxy: false,
        timeout: 8000,
        signal: AbortSignal.timeout(8500),
        maxRedirects: 0,
        maxContentLength: 256_000,
        validateStatus: (status) => status === 200 || status === 404,
    });
    if (response.status === 404) return "unknown";
    if (
        !String(response.headers["content-type"] ?? "").includes(
            "application/json",
        )
    )
        throw new Error("Unexpected lyrics response type");
    return classifyMatchedLyrics(track, response.data);
}
