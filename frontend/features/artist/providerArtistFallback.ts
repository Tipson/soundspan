import type { DiscoverResult } from "@/features/search/types";
import { normalizeArtistName } from "@/features/search/discoverySelection";

const normalizeProviderArtistBaseName = (value: string): string =>
    normalizeArtistName(value)
        .replace(/\s+\([^()]+\)\s*$/u, "")
        .trim();

/** Resolve only an exact provider artist so a same-name local shadow cannot drift. */
export function resolveProviderArtistChannel(
    results: Array<Partial<DiscoverResult>>,
    artistName: string,
): string | null {
    const targetName = normalizeArtistName(artistName);
    if (!targetName) return null;

    const match = results.find(
        (result) =>
            result.type === "music" &&
            (normalizeArtistName(result.name ?? "") === targetName ||
                normalizeProviderArtistBaseName(result.name ?? "") ===
                    targetName) &&
            typeof result.youtubeChannelId === "string" &&
            result.youtubeChannelId.trim().length > 0,
    );

    return match?.youtubeChannelId?.trim() ?? null;
}
