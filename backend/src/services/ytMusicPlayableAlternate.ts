import type { CanonicalMediaSearchResult } from "@soundspan/media-metadata-contract";

export interface YtMusicPlayableAlternateInput {
    artist: string;
    title: string;
    albumTitle?: string;
    duration?: number;
    excludedVideoIds: string[];
}

export interface YtMusicPlayableAlternate {
    videoId: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    thumbnailUrl: string | null;
}

interface AlternateTransportOptions {
    timeoutMs: number;
    maxRetries: number;
}

export interface YtMusicPlayableAlternateDependencies {
    searchSongs(
        userId: string,
        query: string,
        limit: number,
        options: AlternateTransportOptions,
    ): Promise<{ results: CanonicalMediaSearchResult[] }>;
    probeStream(
        userId: string,
        videoId: string,
        options: AlternateTransportOptions,
    ): Promise<unknown>;
}

const MISMATCH_TERMS = [
    "karaoke",
    "tribute",
    "cover",
    "ai cover",
    "nightcore",
    "sped up",
    "slowed",
    "live",
    "acoustic",
    "instrumental",
    "remix",
    "translation",
    "translated",
    "lyrics",
    "lyric",
    "subtitles",
    "subtitle",
    "subbed",
    "making of",
    "behind the scenes",
    "reaction",
    "review",
    "tutorial",
    "fanmade",
    "fan made",
    "extended",
    "edit",
    "demo",
    "rehearsal",
    "performance",
    "bass boosted",
    "8d",
    "amv",
];

function sanitizeIdentity(value: string): string {
    return value
        .replace(/\s*\(.*?\)\s*/g, " ")
        .replace(/\s*\[.*?\]\s*/g, " ")
        .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
        .toLowerCase()
        .replace(/['\u2019]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function compactIdentity(value: string): string {
    return sanitizeIdentity(value).replace(/\s+/g, "");
}

function extractExplicitArtistPrefixedTitle(
    artist: string,
    title: string,
): string | null {
    for (const separator of title.matchAll(/[-–—:|]/gu)) {
        const separatorIndex = separator.index;
        const prefix = title.slice(0, separatorIndex).trim();
        const remainder = title
            .slice(separatorIndex + separator[0].length)
            .trim();
        if (remainder && compactIdentity(prefix) === compactIdentity(artist)) {
            return remainder;
        }
    }
    return null;
}

function removeDuplicatedArtistPrefix(artist: string, title: string): string {
    return extractExplicitArtistPrefixedTitle(artist, title) ?? title;
}

function hasUnexpectedVersionTerm(
    expectedTitle: string,
    candidateTitle: string,
): boolean {
    const countTerm = (value: string, term: string): number => {
        const normalized = ` ${value
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, " ")
            .replace(/\s+/g, " ")
            .trim()} `;
        const needle = ` ${term} `;
        let count = 0;
        let cursor = 0;
        while ((cursor = normalized.indexOf(needle, cursor)) !== -1) {
            count += 1;
            cursor += needle.length;
        }
        return count;
    };
    return MISMATCH_TERMS.some(
        (term) =>
            countTerm(candidateTitle, term) > countTerm(expectedTitle, term),
    );
}

function getTitleDescriptors(title: string): string[] {
    return Array.from(
        title.matchAll(/\(([^()]*)\)|\[([^\[\]]*)\]/gu),
        (match) =>
            (match[1] ?? match[2] ?? "")
                .toLowerCase()
                .replace(/[^\p{L}\p{N}]+/gu, " ")
                .replace(/\s+/g, " ")
                .trim(),
    );
}

function hasOnlySafeFallbackDescriptors(title: string): boolean {
    const descriptors = getTitleDescriptors(title);
    return descriptors.every(
        (descriptor) =>
            /^(?:official )?(?:music )?video(?: (?:hd|hq|4k))?$/.test(
                descriptor,
            ) ||
            /^(?:official )?audio(?: (?:hd|hq|4k))?$/.test(descriptor) ||
            /^(?:hd|hq|4k)$/.test(descriptor),
    );
}

function hasMatchingDescriptorProfile(
    expectedTitle: string,
    candidateTitle: string,
): boolean {
    const expected = getTitleDescriptors(expectedTitle);
    const candidate = getTitleDescriptors(candidateTitle);
    return (
        expected.length === candidate.length &&
        expected.every((descriptor, index) => descriptor === candidate[index])
    );
}

function hasCompatibleDuration(
    expectedDuration: number | undefined,
    candidateDuration: number | null | undefined,
): boolean {
    if (
        !expectedDuration ||
        !Number.isFinite(expectedDuration) ||
        expectedDuration <= 0 ||
        !candidateDuration ||
        !Number.isFinite(candidateDuration) ||
        candidateDuration <= 0
    ) {
        return true;
    }
    const toleranceSec = Math.max(20, Math.min(60, expectedDuration * 0.2));
    return Math.abs(expectedDuration - candidateDuration) <= toleranceSec;
}

function isValidatedProbeResult(
    probe: unknown,
    expectedVideoId: string,
    expectedDuration: number | undefined,
): boolean {
    if (!probe || typeof probe !== "object") return false;
    const record = probe as Record<string, unknown>;
    if (
        record.videoId !== expectedVideoId ||
        typeof record.url !== "string" ||
        !record.url.trim() ||
        typeof record.duration !== "number" ||
        !Number.isFinite(record.duration) ||
        record.duration <= 0
    ) {
        return false;
    }
    return hasCompatibleDuration(expectedDuration, record.duration);
}

function candidateRank(
    candidate: CanonicalMediaSearchResult,
    input: YtMusicPlayableAlternateInput,
): number {
    let rank = 0;
    if (
        input.albumTitle &&
        candidate.albumTitle &&
        compactIdentity(input.albumTitle) ===
            compactIdentity(candidate.albumTitle)
    ) {
        rank += 10_000;
    }
    if (
        input.duration &&
        candidate.durationSec &&
        Number.isFinite(candidate.durationSec)
    ) {
        rank -= Math.abs(input.duration - candidate.durationSec);
    }
    return rank;
}

type RankedCandidate = {
    candidate: CanonicalMediaSearchResult;
    candidateTitle: string;
    matchKind: "exact_artist" | "artist_prefix";
};

/** Find an exact identity and return it only after a bounded stream probe. */
export async function findPlayableYtMusicAlternate(
    dependencies: YtMusicPlayableAlternateDependencies,
    userId: string,
    input: YtMusicPlayableAlternateInput,
): Promise<YtMusicPlayableAlternate | null> {
    const cleanArtist = sanitizeIdentity(input.artist);
    const expectedTitle = removeDuplicatedArtistPrefix(
        input.artist,
        input.title,
    );
    const cleanTitle = sanitizeIdentity(expectedTitle);
    if (!cleanArtist || !cleanTitle) return null;

    let results: CanonicalMediaSearchResult[];
    try {
        const response = await dependencies.searchSongs(
            userId,
            `${input.artist.replace(/\s*\(.*?\)\s*/g, " ").trim()} ${expectedTitle.replace(/\s*\(.*?\)\s*/g, " ").trim()}`
                .replace(/\s+/g, " ")
                .trim(),
            12,
            { timeoutMs: 8_000, maxRetries: 0 },
        );
        results = response.results;
    } catch {
        return null;
    }

    const excluded = new Set(input.excludedVideoIds);
    const seen = new Set<string>();
    const exactCandidates = results
        .map((candidate): RankedCandidate | null => {
            const videoId = candidate.providerTrackId.trim();
            if (
                candidate.providerTrackId !== videoId ||
                !/^[A-Za-z0-9_-]{11}$/.test(videoId) ||
                excluded.has(videoId) ||
                seen.has(videoId)
            ) {
                return null;
            }
            seen.add(videoId);
            const hasExactArtist =
                compactIdentity(candidate.artistName) === cleanArtist;
            const explicitlyPrefixedTitle = extractExplicitArtistPrefixedTitle(
                input.artist,
                candidate.title,
            );
            if (!hasExactArtist && !explicitlyPrefixedTitle) return null;

            const candidateTitle = explicitlyPrefixedTitle ?? candidate.title;
            if (
                (!hasExactArtist &&
                    !hasOnlySafeFallbackDescriptors(candidateTitle)) ||
                compactIdentity(candidateTitle) !==
                    compactIdentity(expectedTitle) ||
                hasUnexpectedVersionTerm(expectedTitle, candidateTitle) ||
                !hasCompatibleDuration(input.duration, candidate.durationSec)
            ) {
                return null;
            }
            return {
                candidate,
                candidateTitle,
                matchKind: hasExactArtist ? "exact_artist" : "artist_prefix",
            };
        })
        .filter((entry): entry is RankedCandidate => entry !== null)
        .sort((left, right) => {
            const score = (entry: RankedCandidate): number =>
                (entry.matchKind === "exact_artist" ? 1_000_000 : 0) +
                (entry.matchKind === "artist_prefix" &&
                hasMatchingDescriptorProfile(
                    expectedTitle,
                    entry.candidateTitle,
                )
                    ? 20_000
                    : 0) +
                candidateRank(entry.candidate, input);
            return score(right) - score(left);
        })
        .slice(0, 3);

    for (const { candidate, matchKind } of exactCandidates) {
        try {
            const probe = await dependencies.probeStream(
                userId,
                candidate.providerTrackId,
                {
                    timeoutMs: 15_000,
                    maxRetries: 0,
                },
            );
            if (
                !isValidatedProbeResult(
                    probe,
                    candidate.providerTrackId,
                    input.duration,
                )
            ) {
                continue;
            }
            return {
                videoId: candidate.providerTrackId,
                title:
                    matchKind === "artist_prefix"
                        ? input.title
                        : candidate.title,
                artist: input.artist,
                album:
                    matchKind === "artist_prefix"
                        ? input.albumTitle || candidate.albumTitle || "Single"
                        : candidate.albumTitle || input.albumTitle || "Single",
                duration:
                    candidate.durationSec && candidate.durationSec > 0
                        ? candidate.durationSec
                        : input.duration || 0,
                thumbnailUrl: candidate.thumbnailUrl,
            };
        } catch {
            // Try the next exact identity; never return an unprobed candidate.
        }
    }
    return null;
}
