/** Provider response failures are classified before singleflight can cache a value. */
export class YouTubeRadioResponseError extends Error {
    constructor(readonly reason: "empty" | "invalid") {
        super(
            `${reason === "empty" ? "Empty" : "Invalid"} YouTube Music radio response`,
        );
    }
}

/** Deliberately excludes Axios request headers, URLs and upstream response bodies. */
export function classifyYouTubeRadioFailure(error: unknown): {
    reason: string;
    upstreamStatus?: number;
} {
    if (error instanceof YouTubeRadioResponseError)
        return { reason: error.reason };
    const record =
        error && typeof error === "object"
            ? (error as Record<string, unknown>)
            : null;
    const response =
        record?.response && typeof record.response === "object"
            ? (record.response as Record<string, unknown>)
            : null;
    const status =
        typeof response?.status === "number" &&
        Number.isInteger(response.status) &&
        response.status >= 100 &&
        response.status <= 599
            ? response.status
            : undefined;
    const reason =
        record?.code === "ECONNABORTED" ||
        record?.code === "ETIMEDOUT" ||
        status === 504
            ? "timeout"
            : status === 429
              ? "rate_limited"
              : status === 404 || status === 410
                ? "seed_unavailable"
                : status !== undefined
                  ? "upstream_http"
                  : "transport";
    return {
        reason,
        ...(status !== undefined ? { upstreamStatus: status } : {}),
    };
}
