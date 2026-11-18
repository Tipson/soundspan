import crypto from "crypto";
import path from "path";

const MAX_SEARCH_CACHE_ENTRY_BYTES = 1024 * 1024;

/** Bound serialized public search metadata before parsing or storing it. */
export const isSearchCacheEntryWithinLimit = (serialized: string): boolean =>
    Buffer.byteLength(serialized, "utf8") <= MAX_SEARCH_CACHE_ENTRY_BYTES;

interface BuildSha256CacheKeyInput {
    identity: string;
    suffix?: string;
    length?: number;
}

export const buildCachePath = (
    basePath: string,
    ...segments: string[]
): string => path.join(basePath, ...segments);

export const buildSha256CacheKey = ({
    identity,
    suffix,
    length = 24,
}: BuildSha256CacheKeyInput): string => {
    const payload = suffix ? `${identity}:${suffix}` : identity;
    return crypto
        .createHash("sha256")
        .update(payload)
        .digest("hex")
        .slice(0, length);
};

export const isPastStaleWindow = (
    timestamp: Date | string | number,
    staleWindowMs: number,
    nowMs = Date.now(),
): boolean => new Date(timestamp).getTime() < nowMs - staleWindowMs;
