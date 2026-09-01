const PROVIDER_PATH_SEGMENT_RE = /^[A-Za-z0-9_-]{1,256}$/;

export type YtMusicStreamQuality = "low" | "medium" | "high" | "lossless";

/** Validate and encode one opaque provider identifier for a sidecar path. */
export function encodeProviderPathSegment(
    value: string,
    field: string,
): string {
    const normalized = value.trim();
    if (!PROVIDER_PATH_SEGMENT_RE.test(normalized)) {
        throw new TypeError(`Invalid YouTube Music ${field}`);
    }
    return encodeURIComponent(normalized);
}

/** Normalize stored and request quality values to sidecar query values. */
export function normalizeYtMusicStreamQuality(
    quality: string | null | undefined,
): YtMusicStreamQuality | undefined {
    const normalized = quality?.trim().toLowerCase();
    if (
        normalized === "low" ||
        normalized === "medium" ||
        normalized === "high" ||
        normalized === "lossless"
    ) {
        return normalized;
    }
    return undefined;
}
