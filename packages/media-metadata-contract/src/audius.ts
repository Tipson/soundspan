/** Explicit supported Audius content nodes; no arbitrary HTTPS or host wildcards. */
export const AUDIUS_MEDIA_ORIGINS = [
    "https://creatornode.audius.co",
    "https://audius-content-7.figment.io",
    "https://audius-02.staked.cloud",
    "https://validator.eeba4a6ca56a0d87af802270217c2a51.r2.cloudflarestorage.com",
] as const;

function parseStreamUrl(value: unknown): URL | null {
    if (typeof value !== "string" || value.length > 4096) return null;
    try {
        const url = new URL(value);
        if (url.username || url.password || url.hash || /[\s\\]/.test(value))
            return null;
        return url;
    } catch {
        return null;
    }
}

/** Validate only the explicit content-node CID transport, never a storage URL. */
export function isAllowedAudiusContentNodeUrl(value: unknown): value is string {
    const url = parseStreamUrl(value);
    if (!url) return false;
    return (
        AUDIUS_MEDIA_ORIGINS.slice(0, 3).some(
            (origin) => origin === url.origin,
        ) &&
        /^\/tracks\/cidstream\/[A-Za-z0-9]{32,120}$/.test(url.pathname) &&
        [...url.searchParams].every(
            ([key, content]) =>
                // Audius signs JSON { data, signature }; treat it as bounded opaque provider data.
                (key === "signature" &&
                    content.length > 0 &&
                    content.length <= 2048 &&
                    !/[\u0000-\u001f\u007f]/.test(content)) ||
                (key === "skip_play_count" &&
                    /^(true|false|0|1)$/.test(content)),
        ) &&
        [...url.searchParams.keys()].length ===
            new Set(url.searchParams.keys()).size
    );
}

/** Exact observed Audius R2 GET signature shape; no general storage credentials/hosts. */
export function isAllowedAudiusCdnUrl(value: unknown): value is string {
    const url = parseStreamUrl(value);
    if (
        !url ||
        url.origin !== AUDIUS_MEDIA_ORIGINS[3] ||
        !/^\/WRb\/Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(url.pathname)
    )
        return false;
    const params = url.searchParams;
    const date = params.get("X-Amz-Date") ?? "";
    if (!/^\d{8}T\d{6}Z$/.test(date)) return false;
    const timestamp = Date.parse(
        `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
    );
    if (
        !Number.isFinite(timestamp) ||
        new Date(timestamp)
            .toISOString()
            .replace(/[-:]/g, "")
            .replace(".000", "") !== date
    )
        return false;
    const expires = params.get("X-Amz-Expires") ?? "";
    return (
        [...params].length === 8 &&
        new Set(params.keys()).size === 8 &&
        params.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256" &&
        params.get("X-Amz-Checksum-Mode") === "ENABLED" &&
        new RegExp(
            `^[A-Za-z0-9]{32}/${date.slice(0, 8)}/ENAM/s3/aws4_request$`,
        ).test(params.get("X-Amz-Credential") ?? "") &&
        /^[1-9]\d{0,3}$/.test(expires) &&
        Number(expires) <= 7200 &&
        params.get("X-Amz-SignedHeaders") === "host" &&
        /^[a-f0-9]{64}$/.test(params.get("X-Amz-Signature") ?? "") &&
        params.get("x-id") === "GetObject"
    );
}

/** Validate a short-lived terminal URL before exposing it to the existing player/CSP. */
export function isAllowedAudiusStreamUrl(value: unknown): value is string {
    return isAllowedAudiusContentNodeUrl(value) || isAllowedAudiusCdnUrl(value);
}
