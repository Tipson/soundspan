import { normalizeRecommendationArtistKey } from "./identityKeys";

interface ArtistCreditedRecommendation {
    readonly track: { readonly artist: { readonly name: string } };
}

function comparePriority(
    left: readonly number[],
    right: readonly number[],
): number {
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function artistKey(name: string | null): string | null {
    if (name === null) return null;
    const key = normalizeRecommendationArtistKey(name);
    return !key || key === "unknown" || key === "unknown artist" ? null : key;
}

/**
 * Order an already admitted, bounded Wave page without changing its rows.
 * Prefer two intervening songs, relaxing that distance when scarce artists
 * would otherwise cause avoidable adjacent pairs. Caller-supplied history
 * must come from its verified server sequence; no identity or taste is inferred.
 */
export function orderWaveRecommendations<
    T extends ArtistCreditedRecommendation,
>(
    admitted: readonly T[],
    verifiedPreviousArtistKeys: readonly (string | null)[] = [],
    check: () => void = () => {},
): T[] {
    check();
    const remaining = admitted.map((row) => ({
        row,
        artist: artistKey(row.track.artist.name),
    }));
    const recent = verifiedPreviousArtistKeys.slice(-2).map(artistKey);
    const counts = new Map<string, number>();
    for (const item of remaining)
        if (item.artist !== null)
            counts.set(item.artist, (counts.get(item.artist) ?? 0) + 1);
    const result: T[] = [];
    while (remaining.length) {
        check();
        let bestIndex = 0;
        let best: readonly number[] | null = null;
        for (let index = 0; index < remaining.length; index++) {
            const artist = remaining[index].artist;
            const adjacent =
                artist !== null && artist === recent.at(-1) ? 1 : 0;
            let forcedAdjacent = 0;
            // A dominant artist needs enough remaining other songs to act as
            // separators. Preserve those separators before optimizing distance.
            for (const [key, count] of counts) {
                const after = count - (key === artist ? 1 : 0);
                const others = remaining.length - 1 - after;
                forcedAdjacent = Math.max(
                    forcedAdjacent,
                    after - others - (key === artist ? 0 : 1),
                );
            }
            const distance = artist !== null && recent.includes(artist) ? 1 : 0;
            const priority = [adjacent, forcedAdjacent, distance];
            if (best === null || comparePriority(priority, best) < 0) {
                best = priority;
                bestIndex = index;
            }
        }
        const [chosen] = remaining.splice(bestIndex, 1);
        result.push(chosen.row);
        if (chosen.artist !== null)
            counts.set(chosen.artist, counts.get(chosen.artist)! - 1);
        recent.push(chosen.artist);
        if (recent.length > 2) recent.shift();
    }
    return result;
}
