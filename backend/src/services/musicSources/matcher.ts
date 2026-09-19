import type { MusicSourceTrack, RecordingRequest } from "./types";

const versions =
    /\b(clean|censored|explicit|live|remix|acoustic|instrumental|karaoke|cover|sped\s*up|slowed|nightcore|demo|radio\s*edit|remaster(?:ed)?)\b|цензур|концерт|ремикс|кавер|акустик/giu;
const normalize = (value: string) =>
    value
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/ё/g, "е")
        .replace(/[^\p{L}\p{N}]/gu, "");
const markers = (title: string) =>
    [...title.toLowerCase().matchAll(versions)]
        .map((m) => normalize(m[0]))
        .sort()
        .join("|");

/** Fail closed for mismatched versions, missing duration, unknown explicitness or previews. */
export function matchesRecording(
    wanted: RecordingRequest,
    candidate: MusicSourceTrack,
): boolean {
    if (
        candidate.preview ||
        !Number.isFinite(candidate.duration) ||
        candidate.duration <= 0 ||
        !Number.isFinite(wanted.duration) ||
        wanted.duration <= 0
    )
        return false;
    if (
        Math.abs(candidate.duration - wanted.duration) >
        Math.min(5, Math.max(2, wanted.duration * 0.015))
    )
        return false;
    if (markers(wanted.title) !== markers(candidate.title)) return false;
    const sameIsrc = Boolean(
        wanted.isrc &&
        candidate.isrc &&
        wanted.isrc.toUpperCase() === candidate.isrc.toUpperCase(),
    );
    if (wanted.isrc && candidate.isrc && !sameIsrc) return false;
    if (
        candidate.contentVersion === "clean" &&
        wanted.contentVersion !== "clean"
    )
        return false;
    if (
        wanted.contentVersion === "clean" &&
        candidate.contentVersion !== "clean"
    )
        return false;
    if (
        wanted.contentVersion === "explicit" &&
        candidate.contentVersion === "unknown" &&
        !sameIsrc
    )
        return false;
    if (sameIsrc) return true;
    return (
        normalize(wanted.title) === normalize(candidate.title) &&
        wanted.artists.length > 0 &&
        wanted.artists.map(normalize).sort().join("|") ===
            candidate.artists.map(normalize).sort().join("|")
    );
}
