const MEDIA_AUTH_COOKIE_NAME = "soundspan_media_auth";
const MEDIA_AUTH_COOKIE_PATH = "/api";
const MAX_BEARER_TOKEN_LENGTH = 8192;

const SENSITIVE_QUERY_PARAM_PATTERN =
    /([?&](?:token|access_token|refresh_token|api[_-]?key)=)[^&#\s]*/gi;
const BEARER_TOKEN_PATTERN = /(Bearer\s+)[^\s,;]+/gi;
const MEDIA_COOKIE_PATTERN = new RegExp(
    `(${MEDIA_AUTH_COOKIE_NAME}=)[^;\\s]*`,
    "gi",
);
const MEDIA_COOKIE_AUTH_PATHS = [
    /^\/api\/library\/cover-art(?:\/|$)/,
    /^\/api\/browse\/ytmusic\/image\/?$/,
    /^\/api\/browse\/tidal\/image\/?$/,
    /^\/api\/social\/profile-picture\/[^/]+\/?$/,
    /^\/api\/audiobooks\/[^/]+\/cover\/?$/,
    /^\/api\/podcasts\/(?:episodes\/)?[^/]+\/cover\/?$/,
    /^\/api\/library\/tracks\/[^/]+\/stream\/?$/,
    /^\/api\/artists\/preview-stream\/[^/]+\/?$/,
    /^\/api\/ytmusic\/(?:stream|stream-public)\/[^/]+\/?$/,
    /^\/api\/youtube\/stream\/[^/]+\/?$/,
    /^\/api\/tidal-streaming\/stream\/[^/]+\/?$/,
    /^\/api\/audiobooks\/[^/]+\/stream\/?$/,
    /^\/api\/podcasts\/[^/]+\/episodes\/[^/]+\/stream\/?$/,
];

/**
 * Mirror the current access token into a same-origin, API-scoped cookie. The
 * frontend proxy consumes this cookie and forwards Authorization instead.
 *
 * @param {string | null} token
 */
function syncBrowserMediaAuthCookie(token) {
    if (typeof document === "undefined") {
        return;
    }

    const secure =
        typeof window !== "undefined" && window.location?.protocol === "https:"
            ? "; Secure"
            : "";
    const value = token ? encodeURIComponent(token) : "";
    const expiry = token ? "" : "; Max-Age=0";
    document.cookie = `${MEDIA_AUTH_COOKIE_NAME}=${value}; Path=${MEDIA_AUTH_COOKIE_PATH}; SameSite=Strict${secure}${expiry}`;
}

/** @param {unknown} value */
function isSafeBearerToken(value) {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_BEARER_TOKEN_LENGTH &&
        !/[\u0000-\u0020\u007f]/.test(value)
    );
}

/** @param {string} value */
function decodeCookieValue(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return null;
    }
}

/**
 * @param {string | null | undefined} cookieHeader
 * @returns {string | null}
 */
function readMediaAuthCookie(cookieHeader) {
    if (!cookieHeader) {
        return null;
    }

    for (const segment of cookieHeader.split(";")) {
        const separator = segment.indexOf("=");
        if (separator < 0) continue;
        const name = segment.slice(0, separator).trim();
        if (name !== MEDIA_AUTH_COOKIE_NAME) continue;
        const decoded = decodeCookieValue(segment.slice(separator + 1).trim());
        return isSafeBearerToken(decoded) ? decoded : null;
    }

    return null;
}

/**
 * @param {string | null | undefined} cookieHeader
 * @returns {string | null}
 */
function removeMediaAuthCookie(cookieHeader) {
    if (!cookieHeader) {
        return null;
    }

    const remaining = cookieHeader
        .split(";")
        .map((segment) => segment.trim())
        .filter((segment) => {
            const separator = segment.indexOf("=");
            const name =
                separator >= 0 ? segment.slice(0, separator).trim() : segment;
            return name !== MEDIA_AUTH_COOKIE_NAME;
        });

    return remaining.length > 0 ? remaining.join("; ") : null;
}

/**
 * Remove legacy query-token transport while preserving non-auth parameters.
 *
 * @param {string | null | undefined} rawUrl
 * @returns {{ url: string, token: string | null }}
 */
function extractLegacyQueryToken(rawUrl) {
    const input = rawUrl || "/";
    try {
        const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
        const parsed = new URL(input, "http://localhost");
        let token = null;
        for (const key of [...parsed.searchParams.keys()]) {
            if (key.toLowerCase() !== "token") continue;
            const candidate = parsed.searchParams.get(key);
            if (token === null && isSafeBearerToken(candidate)) {
                token = candidate;
            }
            parsed.searchParams.delete(key);
        }

        const url = absolute
            ? parsed.toString()
            : `${parsed.pathname}${parsed.search}${parsed.hash}`;
        return { url, token };
    } catch {
        return {
            url: String(input).replace(
                /([?&])token=[^&#\s]*/gi,
                (_match, prefix) => (prefix === "?" ? "?" : ""),
            ),
            token: null,
        };
    }
}

/**
 * Cookie-backed auth is deliberately limited to exact read-only media routes.
 * This avoids turning the general API into a cookie-authenticated CSRF surface.
 *
 * @param {string | null | undefined} method
 * @param {string} requestUrl
 */
function allowsMediaCookieAuthentication(method, requestUrl) {
    const normalizedMethod = String(method || "").toUpperCase();
    if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") {
        return false;
    }

    try {
        const pathname = new URL(requestUrl, "http://localhost").pathname;
        return MEDIA_COOKIE_AUTH_PATHS.some((pattern) =>
            pattern.test(pathname),
        );
    } catch {
        return false;
    }
}

/** @param {unknown} value */
function redactProxyLogValue(value) {
    return String(value ?? "")
        .replace(SENSITIVE_QUERY_PARAM_PATTERN, "$1[redacted]")
        .replace(BEARER_TOKEN_PATTERN, "$1[redacted]")
        .replace(MEDIA_COOKIE_PATTERN, "$1[redacted]");
}

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string} name
 * @returns {string | null}
 */
function getNodeHeader(headers, name) {
    const target = name.toLowerCase();
    for (const [key, rawValue] of Object.entries(headers)) {
        if (key.toLowerCase() !== target) continue;
        const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
        return typeof value === "string" ? value : null;
    }
    return null;
}

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string} name
 */
function deleteNodeHeader(headers, name) {
    const target = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === target) {
            delete headers[key];
        }
    }
}

/**
 * Promote media credentials before the custom server proxy sees the request,
 * then remove the secret cookie/query transports.
 *
 * @param {{ url?: string, method?: string, headers?: Record<string, string | string[] | undefined> }} req
 */
function prepareProxyAuthentication(req) {
    const headers = req.headers || (req.headers = {});
    const preparedUrl = extractLegacyQueryToken(req.url);
    req.url = preparedUrl.url;

    const cookieHeader = getNodeHeader(headers, "cookie");
    const cookieToken = readMediaAuthCookie(cookieHeader);
    const existingAuthorization = getNodeHeader(headers, "authorization");
    const mediaReadAllowed = allowsMediaCookieAuthentication(
        req.method,
        preparedUrl.url,
    );
    const credential = mediaReadAllowed
        ? preparedUrl.token || cookieToken
        : null;
    if (!existingAuthorization && credential) {
        headers.authorization = `Bearer ${credential}`;
    }

    const forwardedCookie = removeMediaAuthCookie(cookieHeader);
    deleteNodeHeader(headers, "cookie");
    if (forwardedCookie) {
        headers.cookie = forwardedCookie;
    }
}

/**
 * Next route-handler equivalent of prepareProxyAuthentication.
 *
 * @param {string} requestUrl
 * @param {Headers} headers
 * @param {string} method
 * @returns {string}
 */
function prepareFetchProxyAuthentication(requestUrl, headers, method) {
    const preparedUrl = extractLegacyQueryToken(requestUrl);
    const cookieHeader = headers.get("cookie");
    const mediaReadAllowed = allowsMediaCookieAuthentication(
        method,
        preparedUrl.url,
    );
    const cookieToken = mediaReadAllowed
        ? readMediaAuthCookie(cookieHeader)
        : null;
    const credential = mediaReadAllowed
        ? preparedUrl.token || cookieToken
        : null;
    if (!headers.has("authorization") && credential) {
        headers.set("authorization", `Bearer ${credential}`);
    }

    const forwardedCookie = removeMediaAuthCookie(cookieHeader);
    if (forwardedCookie) {
        headers.set("cookie", forwardedCookie);
    } else {
        headers.delete("cookie");
    }

    return preparedUrl.url;
}

module.exports = {
    MEDIA_AUTH_COOKIE_NAME,
    syncBrowserMediaAuthCookie,
    readMediaAuthCookie,
    extractLegacyQueryToken,
    redactProxyLogValue,
    prepareProxyAuthentication,
    prepareFetchProxyAuthentication,
};
