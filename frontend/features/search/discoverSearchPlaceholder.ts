/**
 * Preserve the already-rendered discovery prefix only while the same query
 * asks for a larger provider prefix. Never show rows from the previous query.
 */
export function preserveDiscoverPrefixData<T>(
    previousData: T | undefined,
    previousQueryKey: readonly unknown[] | undefined,
    query: string,
    type: string,
): T | undefined {
    if (
        previousQueryKey?.[0] !== "search" ||
        previousQueryKey[1] !== "discover" ||
        previousQueryKey[2] !== query ||
        previousQueryKey[3] !== type
    ) {
        return undefined;
    }
    return previousData;
}
