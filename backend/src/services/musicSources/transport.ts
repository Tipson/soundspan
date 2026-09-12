import axios, { type AxiosRequestConfig } from "axios";
import { Agent } from "node:https";
import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { Readable, Transform } from "node:stream";
import { isBlockedAddress } from "../outboundAddressPolicy";
import {
    MusicSourceError,
    type MusicSource,
    type MusicSourceStream,
    type MusicStreamRequest,
} from "./types";

const suffixes: Record<MusicSource, string[]> = {
    yandex: [
        ".storage.yandex.net",
        ".storage.mds.yandex.net",
        ".storage.yandexcloud.net",
        ".music.yandex.net",
    ],
    vk: [".userapi.com", ".vk-cdn.net", ".vkuseraudio.net", ".vkuseraudio.com"],
};
const maxMediaBytes = 128 * 1024 * 1024;
function lengthOf(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const result = Number(value);
    if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(result) ||
        result > maxMediaBytes
    )
        throw new MusicSourceError("unsupported_stream");
    return result;
}
function validateResponseRange(
    status: number,
    headers: Record<string, string>,
    request: MusicStreamRequest,
) {
    const length = lengthOf(headers["content-length"]);
    if (status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
            headers["content-range"] ?? "",
        );
        if (!match || !request.range)
            throw new MusicSourceError("unsupported_stream");
        const [start, end, total] = match
            .slice(1)
            .map((value) => lengthOf(value)!);
        if (
            end < start ||
            end >= total ||
            (length !== undefined && length !== end - start + 1)
        )
            throw new MusicSourceError("unsupported_stream");
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.range)!;
        const requestedStart = range[1]
            ? Number(range[1])
            : Math.max(0, total - Number(range[2]));
        const requestedEnd =
            range[1] && range[2]
                ? Math.min(total - 1, Number(range[2]))
                : total - 1;
        if (start !== requestedStart || end > requestedEnd)
            throw new MusicSourceError("unsupported_stream");
        return end - start + 1;
    }
    return length;
}
/** Restrict signed media destinations to provider-controlled HTTPS CDN hosts. */
export function isMusicSourceUrlAllowed(
    raw: string,
    provider: MusicSource,
): boolean {
    try {
        const url = new URL(raw);
        return (
            url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            !url.port &&
            !url.hash &&
            suffixes[provider].some(
                (suffix) =>
                    url.hostname === suffix.slice(1) ||
                    url.hostname.endsWith(suffix),
            )
        );
    } catch {
        return false;
    }
}
/** Accept one bounded safe-integer byte range, including open and suffix forms. */
export function validateMusicRange(range: string): boolean {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (!m[1] && !m[2])) return false;
    if (
        [m[1], m[2]].some(
            (s) => s && (!Number.isSafeInteger(Number(s)) || Number(s) < 0),
        )
    )
        return false;
    if (!m[1]) return Number(m[2]) > 0;
    return !m[2] || Number(m[2]) >= Number(m[1]);
}
/** Network seam used by adapters and deterministic upstream contract tests. */
export interface MusicSourceHttp {
    json(
        url: string,
        headers: Record<string, string>,
        signal: AbortSignal,
        form?: Record<string, string>,
    ): Promise<unknown>;
    text(
        url: string,
        provider: MusicSource,
        signal: AbortSignal,
    ): Promise<string>;
    stream(
        url: string,
        provider: MusicSource,
        request: MusicStreamRequest,
        signal: AbortSignal,
    ): Promise<MusicSourceStream>;
}
function statusError(status: number, retryAfter?: string): never {
    if (status === 401) throw new MusicSourceError("auth_required");
    if (status === 403) throw new MusicSourceError("entitlement_required");
    if (status === 429)
        throw new MusicSourceError("rate_limit", Number(retryAfter) || 90);
    throw new MusicSourceError("unavailable");
}
async function pinnedAgent(url: URL, signal: AbortSignal): Promise<Agent> {
    // The HTTP connection uses only these exact vetted addresses; no second DNS lookup.
    let fail = () => {};
    const cancelled = new Promise<never>((_, reject) => {
        fail = () => reject(new MusicSourceError("unavailable"));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
    });
    const addresses = await Promise.race([
        lookup(url.hostname, { all: true }),
        cancelled,
    ]).finally(() => signal.removeEventListener("abort", fail));
    signal.throwIfAborted();
    if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address)))
        throw new MusicSourceError("unsupported_stream");
    const pinnedLookup: LookupFunction = (_host, options, callback) => {
        const candidates = options.family
            ? addresses.filter((a) => a.family === options.family)
            : addresses;
        if (!candidates.length) {
            callback(new Error("No supported address"), "", 4);
            return;
        }
        if (options.all) callback(null, candidates);
        else callback(null, candidates[0].address, candidates[0].family);
    };
    return new Agent({ keepAlive: false, lookup: pinnedLookup });
}
async function requestPinned(
    raw: string,
    options: AxiosRequestConfig,
    signal: AbortSignal,
) {
    const agent = await pinnedAgent(new URL(raw), signal);
    try {
        const response = await axios.request({
            maxContentLength: 2 * 1024 * 1024,
            ...options,
            url: raw,
            httpsAgent: agent,
            signal,
            proxy: false,
            maxRedirects: 0,
            timeout: 8000,
            validateStatus: () => true,
        });
        if (options.responseType === "stream")
            response.data.once("close", () => agent.destroy());
        else agent.destroy();
        return response;
    } catch {
        agent.destroy();
        signal.throwIfAborted();
        throw new MusicSourceError("unavailable");
    }
}
/** Provider HTTP transport with pinned DNS, no credential forwarding and bounded responses. */
export const musicSourceHttp: MusicSourceHttp = {
    async json(raw, headers, parentSignal, form) {
        const url = new URL(raw);
        if (
            url.protocol !== "https:" ||
            !["api.music.yandex.net", "api.vk.com"].includes(url.hostname) ||
            url.port ||
            url.username ||
            url.password ||
            url.hash
        )
            throw new MusicSourceError("unsupported_stream");
        const signal = AbortSignal.any([
            parentSignal,
            AbortSignal.timeout(8000),
        ]);
        const response = await requestPinned(
            raw,
            {
                headers,
                responseType: "json",
                ...(form
                    ? { method: "POST", data: new URLSearchParams(form) }
                    : {}),
            },
            signal,
        );
        if (response.status !== 200)
            statusError(response.status, response.headers["retry-after"]);
        return response.data;
    },
    async text(raw, provider, parentSignal) {
        if (!isMusicSourceUrlAllowed(raw, provider))
            throw new MusicSourceError("unsupported_stream");
        const signal = AbortSignal.any([
            parentSignal,
            AbortSignal.timeout(8000),
        ]);
        const response = await requestPinned(
            raw,
            { responseType: "text", maxContentLength: 8192 },
            signal,
        );
        if (
            response.status !== 200 ||
            typeof response.data !== "string" ||
            response.data.length > 8192
        )
            throw new MusicSourceError("unsupported_stream");
        return response.data;
    },
    async stream(raw, provider, request, parentSignal) {
        if (request.range && !validateMusicRange(request.range))
            throw new MusicSourceError("invalid_request");
        if (
            request.ifRange &&
            (request.ifRange.length > 160 || /[\r\n]/.test(request.ifRange))
        )
            throw new MusicSourceError("invalid_request");
        const signal = AbortSignal.any([
            parentSignal,
            AbortSignal.timeout(15 * 60_000),
        ]);
        let target = raw;
        for (let hop = 0; hop < 3; hop++) {
            if (!isMusicSourceUrlAllowed(target, provider))
                throw new MusicSourceError("unsupported_stream");
            const response = await requestPinned(
                target,
                {
                    method: request.head ? "HEAD" : "GET",
                    responseType: "stream",
                    maxContentLength: maxMediaBytes,
                    headers: {
                        "Accept-Encoding": "identity",
                        ...(request.range ? { Range: request.range } : {}),
                        ...(request.ifRange
                            ? { "If-Range": request.ifRange }
                            : {}),
                    },
                    decompress: false,
                },
                signal,
            );
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                response.data.destroy();
                target = new URL(
                    String(response.headers.location),
                    target,
                ).toString();
                continue;
            }
            const headers: Record<string, string> = {};
            for (const name of [
                "content-type",
                "content-length",
                "content-range",
                "accept-ranges",
                "etag",
                "last-modified",
            ]) {
                const value: unknown = response.headers[name];
                if (
                    typeof value === "string" &&
                    value.length <= 256 &&
                    !/[\r\n]/.test(value)
                )
                    headers[name] = value;
            }
            if (response.status === 416) {
                response.data.destroy();
                const total = /^bytes \*\/(\d+)$/.exec(
                    headers["content-range"] ?? "",
                )?.[1];
                if (total === undefined || !request.range)
                    throw new MusicSourceError("unsupported_stream");
                lengthOf(total);
                return {
                    status: 416,
                    headers: {
                        "content-range": headers["content-range"],
                        "content-length": "0",
                    },
                    data: Readable.from([]),
                };
            }
            if (![200, 206].includes(response.status)) {
                response.data.destroy();
                statusError(response.status, response.headers["retry-after"]);
            }
            if (
                !/^(audio\/mpeg|audio\/mp4|audio\/aac)(?:;|$)/i.test(
                    headers["content-type"] ?? "",
                ) ||
                (response.headers["content-encoding"] &&
                    response.headers["content-encoding"] !== "identity")
            ) {
                response.data.destroy();
                throw new MusicSourceError("unsupported_stream");
            }
            let expected: number | undefined;
            try {
                expected = validateResponseRange(
                    response.status,
                    headers,
                    request,
                );
            } catch (error) {
                response.data.destroy();
                throw error;
            }
            let bytes = 0;
            const bounded = new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                    bytes += chunk.length;
                    callback(
                        bytes > maxMediaBytes ||
                            (expected !== undefined && bytes > expected)
                            ? new MusicSourceError("unsupported_stream")
                            : null,
                        chunk,
                    );
                },
                flush(callback) {
                    callback(
                        !request.head &&
                            expected !== undefined &&
                            bytes !== expected
                            ? new MusicSourceError("unavailable")
                            : null,
                    );
                },
            });
            response.data.once("error", () =>
                bounded.destroy(new MusicSourceError("unavailable")),
            );
            bounded.once("close", () => response.data.destroy());
            response.data.pipe(bounded);
            return { status: response.status, headers, data: bounded };
        }
        throw new MusicSourceError("unsupported_stream");
    },
};
