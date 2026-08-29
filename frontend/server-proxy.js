/* eslint-disable @typescript-eslint/no-require-imports */
const { createProxyMiddleware } = require("http-proxy-middleware");
const {
    prepareProxyAuthentication,
    redactProxyLogValue,
} = require("./lib/media-auth");

// Time-to-first-byte budgets for backend requests, matching the retired
// Next route-handler proxy (lib/apiProxy.ts): 20s for regular API calls,
// 150s for the long-running import preview, and 125s for YouTube audio routes
// whose provider may need the backend's full 120s preparation budget.
const DEFAULT_PROXY_TIMEOUT_MS = 20000;
const DEFAULT_IMPORT_PREVIEW_PROXY_TIMEOUT_MS = 150000;
const DEFAULT_MEDIA_STREAM_PROXY_TIMEOUT_MS = 125000;
const DEFAULT_UNAVAILABLE_RECOVERY_PROXY_TIMEOUT_MS = 90000;
const IMPORT_PREVIEW_PATH_PREFIX = "/api/import/preview";
const UNAVAILABLE_RECOVERY_PATHS = new Set([
    "/api/ytmusic/recover-unavailable",
    "/ytmusic/recover-unavailable",
]);
const MEDIA_STREAM_PATH_PATTERNS = [
    /^(?:api\/)?ytmusic\/(?:stream|stream-public)\/[^/]+$/,
    /^(?:api\/)?youtube\/stream\/[^/]+$/,
];

function parsePositiveTimeoutMs(value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }
    return null;
}

function getRequestPathname(reqUrl) {
    try {
        return new URL(reqUrl || "/", "http://localhost").pathname;
    } catch {
        return "";
    }
}

function isImportPreviewPath(pathname) {
    const normalized = String(pathname || "")
        .replace(/\/+$/, "")
        .toLowerCase();
    // server.js dispatches from a raw createServer handler, so req.url keeps
    // the full /api prefix — but also accept the mount-stripped form in case
    // this proxy is ever Express-mounted under /api (which strips it).
    const candidates = [
        IMPORT_PREVIEW_PATH_PREFIX,
        IMPORT_PREVIEW_PATH_PREFIX.replace(/^\/api/, ""),
    ];
    return candidates.some(
        (prefix) =>
            normalized === prefix || normalized.startsWith(`${prefix}/`),
    );
}

function isMediaStreamPath(pathname) {
    const normalized = String(pathname || "")
        .replace(/^\/+|\/+$/g, "")
        .toLowerCase();
    return MEDIA_STREAM_PATH_PATTERNS.some((pattern) =>
        pattern.test(normalized),
    );
}

function isUnavailableRecoveryPath(pathname) {
    const normalized = String(pathname || "")
        .replace(/\/+$/, "")
        .toLowerCase();
    return UNAVAILABLE_RECOVERY_PATHS.has(normalized);
}

/**
 * Resolve the time-to-first-byte budget for a proxied backend request.
 * Honors PROXY_REQUEST_TIMEOUT_MS globally and
 * PROXY_IMPORT_PREVIEW_TIMEOUT_MS for the import-preview path prefix.
 * YouTube audio routes never drop below 125s so the backend owns its 120s
 * provider-preparation timeout. Unavailable-track recovery gets 90s so its
 * bounded original/search/alternate probes can finish before the client.
 *
 * @param {string} pathname
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
function resolveProxyTimeoutMs(pathname, env = process.env) {
    const globalTimeout =
        parsePositiveTimeoutMs(env.PROXY_REQUEST_TIMEOUT_MS) ??
        DEFAULT_PROXY_TIMEOUT_MS;

    if (isMediaStreamPath(pathname)) {
        return Math.max(globalTimeout, DEFAULT_MEDIA_STREAM_PROXY_TIMEOUT_MS);
    }

    if (isUnavailableRecoveryPath(pathname)) {
        return Math.max(
            globalTimeout,
            DEFAULT_UNAVAILABLE_RECOVERY_PROXY_TIMEOUT_MS,
        );
    }

    if (!isImportPreviewPath(pathname)) {
        return globalTimeout;
    }

    const importPreviewTimeout = parsePositiveTimeoutMs(
        env.PROXY_IMPORT_PREVIEW_TIMEOUT_MS,
    );
    if (importPreviewTimeout !== null) {
        return importPreviewTimeout;
    }

    return Math.max(globalTimeout, DEFAULT_IMPORT_PREVIEW_PROXY_TIMEOUT_MS);
}

/**
 * Build an http-proxy-middleware `on.proxyReq` handler that enforces a
 * time-to-first-byte timeout: if the backend has not started responding
 * within the resolved budget, the client gets the structured 504
 * UPSTREAM_TIMEOUT JSON contract and the upstream request is aborted.
 * Once the upstream response starts, the timer is cancelled so streaming
 * responses are never cut off by this budget.
 *
 * @param {{ name: string, logger: { error: Function }, env?: Record<string, string | undefined> }} config
 * @returns {(proxyReq: import("http").ClientRequest, req: { method?: string, url?: string }, res: import("http").ServerResponse) => void}
 */
function createFirstByteTimeoutProxyReqHandler({ name, logger, env }) {
    return (proxyReq, req, res) => {
        const timeoutMs = resolveProxyTimeoutMs(
            getRequestPathname(req?.url),
            env ?? process.env,
        );

        const timer = setTimeout(() => {
            const safeUrl = redactProxyLogValue(req?.url);
            logger.error(
                `[${name}] ${req?.method} ${safeUrl} timed out after ${timeoutMs}ms waiting for the first upstream byte`,
            );
            if (
                res &&
                typeof res.writeHead === "function" &&
                !res.headersSent &&
                res.writableEnded !== true
            ) {
                res.writeHead(504, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        error: "Upstream request timed out",
                        code: "UPSTREAM_TIMEOUT",
                        description:
                            "The frontend could not get a response from the backend in time.",
                    }),
                );
            }
            if (typeof proxyReq.destroy === "function") {
                proxyReq.destroy();
            }
        }, timeoutMs);
        if (typeof timer.unref === "function") {
            timer.unref();
        }

        const clear = () => clearTimeout(timer);
        // First upstream byte arrived: streaming proceeds untimed.
        proxyReq.on("response", clear);
        // Upstream failed some other way; the error handler owns the reply.
        proxyReq.on("error", clear);
        // Client response finished/aborted; nothing left to time.
        if (res && typeof res.on === "function") {
            res.on("close", clear);
        }
    };
}

/**
 * Build an http-proxy-middleware (v3+) error handler that preserves
 * the structured 503 JSON error contract ({ error, code }) used by all
 * backend proxies in server.js.
 *
 * v3 removed the v2 `onError` option, so handlers must be registered
 * via `on.error`; when a custom handler is registered, hpm also skips
 * its default error response (still true in v4, which swapped the
 * underlying proxy from http-proxy to httpxy). WebSocket upgrade
 * failures hand the handler a raw socket instead of a ServerResponse,
 * so socket-like targets are destroyed rather than written to.
 *
 * @param {{ name: string, logger: { error: Function }, errorMessage: string, errorCode: string }} config
 * @returns {(err: unknown, req: { method?: string, url?: string }, res: unknown) => void}
 */
function createProxyErrorHandler({ name, logger, errorMessage, errorCode }) {
    return (err, req, res) => {
        const detail = redactProxyLogValue(
            err instanceof Error ? err.message : String(err),
        );
        const safeUrl = redactProxyLogValue(req?.url);
        logger.error(`[${name}] ${req?.method} ${safeUrl} failed:`, detail);

        if (res && typeof res.writeHead === "function") {
            if (!res.headersSent) {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        error: errorMessage,
                        code: errorCode,
                    }),
                );
            }
            return;
        }

        if (res && typeof res.destroy === "function") {
            res.destroy();
        }
    };
}

/**
 * Build the shared http-proxy-middleware options for a backend proxy
 * (target, forwarding headers, timeouts, structured error handler).
 *
 * When `firstByteTimeout` is set, requests also get a per-path
 * time-to-first-byte budget (see {@link resolveProxyTimeoutMs}) answered
 * with the 504 UPSTREAM_TIMEOUT contract, and the socket timeouts are
 * widened so a configured budget larger than 120s can actually elapse.
 * Only the upstream proxy request gets this timeout: httpxy attaches a new
 * listener whenever its downstream `timeout` option is used, which accumulates
 * listeners on keep-alive client sockets.
 *
 * @param {{ name: string, target: string, ws?: boolean, logger: { error: Function }, errorMessage: string, errorCode: string, firstByteTimeout?: boolean, env?: Record<string, string | undefined> }} config
 * @returns {import("http-proxy-middleware").Options}
 */
function buildBackendProxyOptions({
    name,
    target,
    ws = false,
    logger,
    errorMessage,
    errorCode,
    firstByteTimeout = false,
    env,
}) {
    const activeEnv = env ?? process.env;
    const socketTimeoutMs = firstByteTimeout
        ? Math.max(
              120000,
              resolveProxyTimeoutMs("/api/", activeEnv),
              resolveProxyTimeoutMs(IMPORT_PREVIEW_PATH_PREFIX, activeEnv),
              resolveProxyTimeoutMs("/api/ytmusic/stream-public/_", activeEnv),
          )
        : 120000;

    const on = {
        error: createProxyErrorHandler({
            name,
            logger,
            errorMessage,
            errorCode,
        }),
    };
    if (firstByteTimeout) {
        on.proxyReq = createFirstByteTimeoutProxyReqHandler({
            name,
            logger,
            env,
        });
    }

    return {
        target,
        changeOrigin: true,
        ws: Boolean(ws),
        xfwd: true,
        proxyTimeout: socketTimeoutMs,
        on,
    };
}

/**
 * Create a backend proxy middleware (with `.upgrade` for websocket
 * proxies) that streams requests to the backend and answers with the
 * structured 503 JSON contract when the backend is unreachable.
 *
 * @param {{ name: string, target: string, ws?: boolean, logger: { error: Function }, errorMessage: string, errorCode: string, promoteAuthToken?: boolean }} config
 * @returns {import("http-proxy-middleware").RequestHandler}
 */
function createBackendProxy(config) {
    const proxy = createProxyMiddleware(buildBackendProxyOptions(config));
    if (!config.promoteAuthToken) {
        return proxy;
    }

    const authenticatedProxy = (req, res, next) => {
        prepareProxyAuthentication(req);
        return proxy(req, res, next);
    };
    if (typeof proxy.upgrade === "function") {
        authenticatedProxy.upgrade = (req, socket, head) => {
            prepareProxyAuthentication(req);
            return proxy.upgrade(req, socket, head);
        };
    }
    return authenticatedProxy;
}

module.exports = {
    createProxyErrorHandler,
    createFirstByteTimeoutProxyReqHandler,
    prepareProxyAuthentication,
    resolveProxyTimeoutMs,
    buildBackendProxyOptions,
    createBackendProxy,
};
