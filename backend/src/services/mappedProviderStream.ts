import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { Request, Response } from "express";
import type { PeerPlaybackFallback } from "./peerPlaybackFallback";
import { remoteProviderAdapters } from "./remoteProviders/adapters";
import { toMappingProvider } from "./remoteProviders/types";
import { createStreamProxyRequestAbort } from "../routes/streamProxyRequestAbort";

const FORWARDED_STREAM_HEADERS = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
] as const;

/** Observable response state after a mapped provider attempt. */
export interface MappedProviderResponseState {
    headersSent: boolean;
    destroyed: boolean;
    writableEnded: boolean;
}

/** Result of one mapped provider stream attempt. */
export type MappedProviderStreamResult =
    | { status: "served" }
    | { status: "cancelled" }
    | { status: "unavailable" }
    | {
          status: "failed";
          failure: unknown;
          responseState: MappedProviderResponseState;
      };

/** Reports whether a response can still accept a fallback or error body. */
export function mappedProviderResponseState(
    res: Response,
): MappedProviderResponseState {
    return {
        headersSent: res.headersSent,
        destroyed: res.destroyed,
        writableEnded: res.writableEnded,
    };
}

/** Returns whether no further response write is safe. */
export function isMappedProviderResponseUnusable(
    state: MappedProviderResponseState,
): boolean {
    return state.headersSent || state.destroyed || state.writableEnded;
}

function forwardStreamHeaders(
    res: Response,
    headers: Record<string, unknown>,
): void {
    for (let index = 0; index < FORWARDED_STREAM_HEADERS.length; index += 1) {
        const name = FORWARDED_STREAM_HEADERS[index];
        const value = headers[name];
        if (typeof value === "string" || typeof value === "number") {
            res.setHeader(name, String(value));
        }
    }
}

/** Proxies one already-mapped provider fallback through its bounded sidecar call. */
export async function serveMappedProviderStream(input: {
    req: Request;
    res: Response;
    userId: string;
    youtubeUserId?: string;
    quality: string;
    fallback: PeerPlaybackFallback;
}): Promise<MappedProviderStreamResult> {
    const range =
        typeof input.req.headers.range === "string"
            ? input.req.headers.range
            : undefined;
    const lifetime = createStreamProxyRequestAbort(input.req, input.res);
    const wasCancelled = () =>
        lifetime.wasClientAborted() ||
        (input.res.destroyed && !input.res.writableEnded);
    let body: Readable | undefined;
    let upstreamFailed = false;
    const noteUpstreamFailure = () => {
        if (!wasCancelled()) upstreamFailed = true;
    };
    const noteUpstreamClose = () => {
        if (!body?.readableEnded) noteUpstreamFailure();
    };
    try {
        if (wasCancelled()) return { status: "cancelled" };
        if (input.fallback.source === "library") {
            return { status: "unavailable" };
        }
        const adapter =
            remoteProviderAdapters[toMappingProvider(input.fallback.source)];
        const response = await adapter.streamTrack({
            userId: input.youtubeUserId ?? "__public__",
            quality: input.quality,
            range,
            youtubeVideoId: input.fallback.youtubeVideoId,
            signal: lifetime.signal,
        });
        if (wasCancelled()) {
            response?.data.destroy();
            return { status: "cancelled" };
        }
        if (!response) return { status: "unavailable" };
        body = response.data;
        // Pipeline destroys the HTTP response after an upstream failure too.
        // Preserve that distinction from a listener leaving the player.
        body.once("error", noteUpstreamFailure);
        body.once("close", noteUpstreamClose);
        input.res.status(response.status);
        forwardStreamHeaders(input.res, response.headers);
        await pipeline(response.data, input.res);
        return { status: "served" };
    } catch (error) {
        if (wasCancelled() && !upstreamFailed) return { status: "cancelled" };
        return {
            status: "failed",
            failure: error,
            responseState: mappedProviderResponseState(input.res),
        };
    } finally {
        lifetime.dispose();
        body?.off("error", noteUpstreamFailure);
        body?.off("close", noteUpstreamClose);
    }
}

/** Terminates a stream whose HTTP headers were already committed. */
export function terminateCommittedStream(res: Response): void {
    if (res.destroyed || res.writableEnded) return;
    if (typeof res.destroy === "function") {
        res.destroy();
        return;
    }
    res.end();
}
