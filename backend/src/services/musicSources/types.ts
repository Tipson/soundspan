import type { Readable } from "node:stream";

/** Direct music transports with server-owned authorization. */
export type MusicSource = "yandex" | "vk";
/** Sanitized recording metadata; never contains a signed media URL. */
export interface MusicSourceTrack {
    provider: MusicSource;
    id: string;
    title: string;
    artists: string[];
    duration: number;
    isrc?: string;
    contentVersion: "explicit" | "clean" | "unknown";
    preview: boolean;
}
/** Recording request independent of any particular transport. */
export type RecordingRequest = Omit<
    MusicSourceTrack,
    "provider" | "id" | "preview"
>;
/** HTTP representation headers accepted from the authenticated browser. */
export interface MusicStreamRequest {
    range?: string;
    ifRange?: string;
    head?: boolean;
}
/** Owned upstream response; consumers must destroy it on cancellation. */
export interface MusicSourceStream {
    status: number;
    headers: Record<string, string>;
    data: Readable;
}
/** One immutable credential generation; instances must not change tokens in flight. */
export interface MusicSourceAdapter {
    provider: MusicSource;
    version: number;
    enabled: boolean;
    search(query: string, signal: AbortSignal): Promise<MusicSourceTrack[]>;
    lookup(id: string, signal: AbortSignal): Promise<MusicSourceTrack | null>;
    open(
        id: string,
        request: MusicStreamRequest,
        signal: AbortSignal,
    ): Promise<MusicSourceStream>;
}
/** Low-cardinality failure safe for HTTP responses and diagnostics. */
export type MusicSourceErrorCode =
    | "not_found"
    | "lease_expired"
    | "busy"
    | "rate_limit"
    | "provider_challenge"
    | "auth_required"
    | "entitlement_required"
    | "unavailable"
    | "unsupported_stream"
    | "invalid_request";
/** Provider errors deliberately omit upstream bodies, credentials and URLs. */
export class MusicSourceError extends Error {
    constructor(
        readonly code: MusicSourceErrorCode,
        readonly retryAfter = 90,
    ) {
        super(code);
        this.name = "MusicSourceError";
    }
}
