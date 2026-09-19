import { createHash } from "node:crypto";
import { detectAll } from "tinyld";

/** Language filter describes vocals, not the artist's country or title script. */
export type WaveLanguage = "any" | "ru" | "foreign";
export type RecordingLanguage = "ru" | "foreign" | "instrumental" | "unknown";
export interface LanguageRecording {
    title: string;
    artist: { name: string };
    album: { title: string };
    duration: number;
}
export interface RecordingLyrics {
    plainLyrics?: string | null;
    syncedLyrics?: string | null;
    instrumental: boolean;
}

/** Unicode-safe recording identity; no user data or lyrics are stored in the key. */
export function languageCacheKey(track: LanguageRecording): string {
    const parts = [track.artist.name, track.title, track.album.title].map(
        (value) => value.normalize("NFKC").trim().toLowerCase(),
    );
    return `wave:language:v1:${createHash("sha256")
        .update(JSON.stringify([...parts, Math.round(track.duration)]))
        .digest("hex")}`;
}

/** Reject stale/invalid cache formats rather than accepting arbitrary labels. */
export function parseLanguageCache(
    value: string | null,
): RecordingLanguage | null {
    return value === "ru" ||
        value === "foreign" ||
        value === "unknown" ||
        value === "instrumental"
        ? value
        : null;
}

function confidentGroup(text: string): "ru" | "foreign" | null {
    if ((text.match(/\p{L}/gu)?.length ?? 0) < 80) return null;
    const scores = detectAll(text);
    const russian = scores.find((score) => score.lang === "ru")?.accuracy ?? 0;
    const foreign = scores
        .filter((score) => score.lang !== "ru")
        .reduce((sum, score) => sum + score.accuracy, 0);
    // Detector scores are relative scores, not calibrated probabilities.
    // The product distinguishes Russian from all other languages, not English
    // from German. Competing foreign-language labels belong to the same group.
    const strongest = Math.max(russian, foreign);
    const total = russian + foreign;
    // TinyLD scores are not normalized (their sum can be below or above one).
    // Require both actual evidence and a dominant group, not a raw 0.8 score.
    if (strongest < 0.5 || strongest / total < 0.8) return null;
    return russian > foreign ? "ru" : "foreign";
}

/** Conservative local classification of matched lyrics; ambiguous vocals stay unknown. */
export function classifyRecordingLanguage(
    lyrics: RecordingLyrics,
): RecordingLanguage {
    const text = (lyrics.plainLyrics || lyrics.syncedLyrics || "")
        .slice(0, 32_000)
        .replace(/\[[^\]\r\n]*\]/g, "")
        .trim();
    if (lyrics.instrumental) return text ? "unknown" : "instrumental";
    const overall = confidentGroup(text);
    if (!overall) return "unknown";
    const groups = new Set<string>();
    // Whole-text detection alone can conceal a verse in a second language.
    const verses = text.split(/\r?\n/).filter((line) => line.trim());
    let section = "";
    for (const verse of verses) {
        section += `${verse} `;
        if ((section.match(/\p{L}/gu)?.length ?? 0) < 80) continue;
        const group = confidentGroup(section);
        if (group) groups.add(group);
        section = "";
    }
    if (groups.size > 1 || [...groups].some((group) => group !== overall))
        return "unknown";
    return overall;
}

/** A strict language selection never silently backfills with unclassified tracks. */
export function matchesWaveLanguage(
    language: RecordingLanguage | null,
    filter: WaveLanguage,
): boolean {
    return filter === "any" || language === filter;
}
