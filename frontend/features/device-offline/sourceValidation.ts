import { DeviceOfflineDownloadError } from "./downloadError";

const STREAM_SOURCE_PATHS = [
    /^\/api\/library\/tracks\/[^/]+\/stream\/?$/,
    /^\/api\/artists\/preview-stream\/[^/]+\/?$/,
    /^\/api\/ytmusic\/(?:stream|stream-public)\/[^/]+\/?$/,
    /^\/api\/youtube\/stream\/[^/]+\/?$/,
    /^\/api\/tidal-streaming\/stream\/[^/]+\/?$/,
    /^\/api\/audiobooks\/[^/]+\/stream\/?$/,
    /^\/api\/podcasts\/[^/]+\/episodes\/[^/]+\/stream\/?$/,
];
const SENSITIVE_QUERY_NAMES = new Set([
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
]);

/** Validate and redact the same-origin stream URL retained in device metadata. */
export function normalizeDeviceAudioSourceUrl(
    sourceUrl: string,
    origin: string,
): { absolute: string; stored: string } {
    const parsed = new URL(sourceUrl, origin);
    if (parsed.origin !== new URL(origin).origin) {
        throw new DeviceOfflineDownloadError(
            "invalid_source",
            "Device downloads require a same-origin audio URL",
        );
    }
    for (const name of parsed.searchParams.keys()) {
        if (SENSITIVE_QUERY_NAMES.has(name.toLowerCase())) {
            throw new DeviceOfflineDownloadError(
                "invalid_source",
                "Device download URL contains a credential",
            );
        }
    }
    if (!STREAM_SOURCE_PATHS.some((pattern) => pattern.test(parsed.pathname))) {
        throw new DeviceOfflineDownloadError(
            "invalid_source",
            "Device download URL is not an approved audio route",
        );
    }
    return {
        absolute: parsed.toString(),
        stored: `${parsed.pathname}${parsed.search}`,
    };
}
