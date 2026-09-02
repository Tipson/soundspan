import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";

const DEFAULT_SPOTIFY_REQUEST_DEADLINE_MS = 10_000;

/**
 * Axios' socket timeout does not cover every proxy/connect failure mode.
 * Pair it with an AbortSignal deadline so a broken egress proxy cannot leave
 * imports waiting forever before an HTTP response exists.
 */
export async function spotifyGetWithDeadline<T = any>(
    url: string,
    config: AxiosRequestConfig = {},
    deadlineMs = typeof config.timeout === "number"
        ? config.timeout
        : DEFAULT_SPOTIFY_REQUEST_DEADLINE_MS,
): Promise<AxiosResponse<T>> {
    return await axios.get<T>(url, {
        ...config,
        timeout: deadlineMs,
        signal: AbortSignal.timeout(deadlineMs),
    });
}

/** Applies the same connect-safe deadline to Spotify web-player POST calls. */
export async function spotifyPostWithDeadline<T = any>(
    url: string,
    data: unknown,
    config: AxiosRequestConfig = {},
    deadlineMs = typeof config.timeout === "number"
        ? config.timeout
        : DEFAULT_SPOTIFY_REQUEST_DEADLINE_MS,
): Promise<AxiosResponse<T>> {
    return await axios.post<T>(url, data, {
        ...config,
        timeout: deadlineMs,
        signal: AbortSignal.timeout(deadlineMs),
    });
}
