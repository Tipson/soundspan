import { isPlainObject } from "../utils/plainObject";
import { isValidMbid } from "../utils/musicIds";

const MIN_METADATA_SCORE = 95;
const MAX_DURATION_DELTA_SECONDS = 12;
const PROVIDER_NOISE =
    /[\[(](?:official\s+)?(?:music\s+)?(?:video|audio|lyric\s+video|lyrics|visuali[sz]er)[\])]/giu;
const VERSION_MARKERS = [
    { category: "live", aliases: ["live"] },
    { category: "remix", aliases: ["remix", "remixed"] },
    { category: "remaster", aliases: ["remaster", "remastered"] },
    { category: "acoustic", aliases: ["acoustic"] },
    { category: "demo", aliases: ["demo"] },
    { category: "instrumental", aliases: ["instrumental"] },
    { category: "karaoke", aliases: ["karaoke"] },
    { category: "sped-up", aliases: ["sped up"] },
    { category: "slowed", aliases: ["slowed"] },
] as const;

export interface MusicBrainzMetadataIdentity {
    recordingMbid: string;
    isrc: string | null;
    confidence: number;
}

interface ExpectedRecordingMetadata {
    title: string;
    artist: string;
    duration?: number;
}

function normalizeIsrc(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.replace(/[^a-z0-9]/giu, "").toUpperCase();
    return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized) ? normalized : null;
}

function normalizeWords(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase("en-US")
        .replace(/\b(?:feat(?:uring)?|ft|and|и)\b/giu, " ")
        .replace(/&/g, " ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function normalizedTitle(value: string): string {
    return normalizeWords(value.replace(PROVIDER_NOISE, " "));
}

function versionMarkers(value: string): string[] {
    const normalized = normalizeWords(value);
    const padded = ` ${normalized} `;
    return VERSION_MARKERS.flatMap(({ category, aliases }) =>
        aliases.some((alias) => padded.includes(` ${alias} `))
            ? [category]
            : [],
    );
}

function recordingArtist(value: Record<string, unknown>): string {
    if (!Array.isArray(value["artist-credit"])) return "";
    return value["artist-credit"]
        .flatMap((credit) => {
            if (!isPlainObject(credit)) return [];
            if (typeof credit.name === "string") return [credit.name];
            const artist = credit.artist;
            return isPlainObject(artist) && typeof artist.name === "string"
                ? [artist.name]
                : [];
        })
        .join(" ");
}

function uniqueIsrc(value: unknown): string | null {
    if (!Array.isArray(value)) return null;
    const values = Array.from(
        new Set(value.flatMap((candidate) => normalizeIsrc(candidate) ?? [])),
    );
    return values.length === 1 ? values[0] : null;
}

/** Accept an ISRC lookup only when it identifies exactly one recording. */
export function parseRecordingMbidFromIsrcLookup(
    value: unknown,
): string | null {
    if (!isPlainObject(value) || !Array.isArray(value.recordings)) return null;
    const ids = Array.from(
        new Set(
            value.recordings.flatMap((recording) => {
                if (!isPlainObject(recording) || !isValidMbid(recording.id)) {
                    return [];
                }
                return [recording.id];
            }),
        ),
    );
    return ids.length === 1 ? ids[0] : null;
}

/** Select one strict recording match without collapsing live/remix variants. */
export function parseRecordingIdentityFromMetadataSearch(
    value: unknown,
    expected: ExpectedRecordingMetadata,
): MusicBrainzMetadataIdentity | null {
    if (!isPlainObject(value) || !Array.isArray(value.recordings)) return null;
    const expectedTitle = normalizedTitle(expected.title);
    const expectedArtist = normalizeWords(expected.artist);
    const expectedVersions = versionMarkers(expected.title);
    if (!expectedTitle || !expectedArtist) return null;

    const matches = value.recordings.flatMap((recording) => {
        if (
            !isPlainObject(recording) ||
            !isValidMbid(recording.id) ||
            typeof recording.title !== "string"
        ) {
            return [];
        }
        const score = Number(recording.score);
        if (!Number.isFinite(score) || score < MIN_METADATA_SCORE) return [];
        if (normalizedTitle(recording.title) !== expectedTitle) return [];
        if (normalizeWords(recordingArtist(recording)) !== expectedArtist) {
            return [];
        }
        const candidateVersions = versionMarkers(
            `${recording.title} ${
                typeof recording.disambiguation === "string"
                    ? recording.disambiguation
                    : ""
            }`,
        );
        if (candidateVersions.join("|") !== expectedVersions.join("|")) {
            return [];
        }
        const lengthMs = recording.length;
        const durationDelta =
            expected.duration !== undefined &&
            typeof lengthMs === "number" &&
            Number.isFinite(lengthMs)
                ? Math.abs(lengthMs / 1000 - expected.duration)
                : null;
        if (
            durationDelta !== null &&
            durationDelta > MAX_DURATION_DELTA_SECONDS
        ) {
            return [];
        }
        return [
            {
                recordingMbid: recording.id,
                isrc: uniqueIsrc(recording.isrcs),
                confidence: durationDelta === null ? 0.92 : 0.94,
            } satisfies MusicBrainzMetadataIdentity,
        ];
    });
    const unique = new Map(
        matches.map((match) => [match.recordingMbid, match] as const),
    );
    if (unique.size !== 1) return null;
    const match = [...unique.values()][0];
    return match
        ? { ...match, confidence: match.isrc ? 0.96 : match.confidence }
        : null;
}

/** Return one unambiguous normalized ISRC for a recording lookup. */
export function parseRecordingIsrcFromLookup(value: unknown): string | null {
    if (!isPlainObject(value) || !isValidMbid(value.id)) return null;
    return uniqueIsrc(value.isrcs);
}
