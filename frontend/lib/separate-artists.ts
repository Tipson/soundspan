/**
 * Round-robin interleave to spread same-artist tracks apart.
 *
 * Preserves each artist's input order; a dominant artist may still repeat
 * after other buckets are exhausted.
 */
export function separateArtists<T>(
    items: T[],
    getArtistKey: (item: T) => string,
): T[] {
    if (items.length <= 1) return items;

    const bucketMap = new Map<string, T[]>();
    for (const item of items) {
        const key = getArtistKey(item);
        let bucket = bucketMap.get(key);
        if (!bucket) {
            bucket = [];
            bucketMap.set(key, bucket);
        }
        bucket.push(item);
    }

    const buckets = Array.from(bucketMap.values()).sort(
        (a, b) => b.length - a.length,
    );

    const result: T[] = [];
    const maxLen = buckets[0].length;
    for (let round = 0; round < maxLen; round++) {
        for (const bucket of buckets) {
            // Descending lengths mean every remaining bucket is exhausted too.
            if (round >= bucket.length) break;
            result.push(bucket[round]);
        }
    }

    return result;
}
