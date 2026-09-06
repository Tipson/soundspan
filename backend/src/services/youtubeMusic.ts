import axios, {
    type AxiosAdapter,
    type AxiosInstance,
    type AxiosRequestConfig,
    type InternalAxiosRequestConfig,
} from "axios";
import http from "node:http";
import https from "node:https";
import pLimit from "p-limit";
import { config } from "../config";
import { logger } from "../utils/logger";
import type { CanonicalMediaSearchResult } from "@soundspan/media-metadata-contract";
import {
    cachedSingleflight,
    coalesceInFlightByKey,
    type CachedSingleflight,
} from "../utils/singleflight";
import {
    findPlayableYtMusicAlternate,
    type YtMusicPlayableAlternate,
    type YtMusicPlayableAlternateInput,
} from "./ytMusicPlayableAlternate";
import { retryYtMusicRequest as retryWithBackoff } from "./youtubeMusicRetry";
import { encodeProviderPathSegment } from "./youtubeMusicInput";
export type {
    YtMusicPlayableAlternate,
    YtMusicPlayableAlternateInput,
} from "./ytMusicPlayableAlternate";
export {
    normalizeYtMusicStreamQuality,
    type YtMusicStreamQuality,
} from "./youtubeMusicInput";

// ── Sidecar URL ────────────────────────────────────────────────────
// Some consumers import the provider transitively while supplying a narrow
// test/runtime config facade. Real startup validation still owns this value;
// keep module evaluation side-effect free for consumers that never call it.
const YTMUSIC_STREAMER_URL =
    config.ytmusicStreamer?.url ?? "http://ytmusic-streamer:8585";
const STREAM_PROXY_DEFAULT_TIMEOUT_MS = 120_000;
const CONTROL_REQUEST_DEFAULT_TIMEOUT_MS = 30_000;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
const CONTROL_REQUEST_ACTIVE_LIMIT = 16;
const CONTROL_REQUEST_QUEUE_LIMIT = 128;
const INTERACTIVE_STREAM_ACTIVE_LIMIT = 120;
const INTERACTIVE_STREAM_QUEUE_LIMIT = 120;
const BACKGROUND_STREAM_ACTIVE_LIMIT = 8;
const BACKGROUND_STREAM_QUEUE_LIMIT = 8;
const STREAM_INFO_MAX_IN_FLIGHT = 1_000;
const CONTROL_SIDECAR_AGENT_OPTIONS = {
    keepAlive: true,
    maxSockets: CONTROL_REQUEST_ACTIVE_LIMIT,
    maxTotalSockets: CONTROL_REQUEST_ACTIVE_LIMIT,
    maxFreeSockets: 8,
};
const INTERACTIVE_SIDECAR_AGENT_OPTIONS = {
    keepAlive: true,
    maxSockets: INTERACTIVE_STREAM_ACTIVE_LIMIT,
    maxTotalSockets: INTERACTIVE_STREAM_ACTIVE_LIMIT,
    maxFreeSockets: 16,
};
const BACKGROUND_SIDECAR_AGENT_OPTIONS = {
    keepAlive: true,
    maxSockets: BACKGROUND_STREAM_ACTIVE_LIMIT,
    maxTotalSockets: BACKGROUND_STREAM_ACTIVE_LIMIT,
    maxFreeSockets: 4,
};
const SIDE_CAR_CONTROL_HTTP_AGENT = new http.Agent(
    CONTROL_SIDECAR_AGENT_OPTIONS,
);
const SIDE_CAR_CONTROL_HTTPS_AGENT = new https.Agent(
    CONTROL_SIDECAR_AGENT_OPTIONS,
);
const SIDE_CAR_INTERACTIVE_HTTP_AGENT = new http.Agent(
    INTERACTIVE_SIDECAR_AGENT_OPTIONS,
);
const SIDE_CAR_INTERACTIVE_HTTPS_AGENT = new https.Agent(
    INTERACTIVE_SIDECAR_AGENT_OPTIONS,
);
const SIDE_CAR_BACKGROUND_HTTP_AGENT = new http.Agent(
    BACKGROUND_SIDECAR_AGENT_OPTIONS,
);
const SIDE_CAR_BACKGROUND_HTTPS_AGENT = new https.Agent(
    BACKGROUND_SIDECAR_AGENT_OPTIONS,
);

type StreamAdmissionRelease = () => void;
type SidecarAdmissionLane = "control" | "interactive" | "background";

interface StreamAdmissionWaiter {
    signal?: AbortSignal;
    deadlineAtMs: number;
    deadlineTimer?: ReturnType<typeof setTimeout>;
    resolve: (release: StreamAdmissionRelease) => void;
    reject: (error: Error) => void;
    abort: () => void;
}

class StreamProxyCapacityError extends Error {
    readonly response = { status: 503 };

    constructor(lane: SidecarAdmissionLane) {
        super(`YouTube Music ${lane} request capacity reached`);
        this.name = "StreamProxyCapacityError";
    }
}

class StreamProxyDeadlineError extends Error {
    readonly response = { status: 504 };

    constructor(lane: SidecarAdmissionLane) {
        super(`YouTube Music ${lane} request deadline exceeded`);
        this.name = "StreamProxyDeadlineError";
    }
}

function abortReason(signal: AbortSignal): Error {
    if (signal.reason instanceof Error) return signal.reason;
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
}

function resolveStreamProxyBudgetMs(timeoutMs: number | undefined): number {
    if (
        timeoutMs === undefined ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > MAX_NODE_TIMER_DELAY_MS
    ) {
        return STREAM_PROXY_DEFAULT_TIMEOUT_MS;
    }
    return Math.max(1, timeoutMs);
}

/** Bounds speculative stream work before it reaches Node's unbounded Agent queue. */
class BoundedStreamAdmission {
    private active = 0;
    private readonly waiters: StreamAdmissionWaiter[] = [];

    constructor(
        private readonly maxActive: number,
        private readonly maxQueued: number,
        private readonly lane: SidecarAdmissionLane,
    ) {}

    acquire(
        deadlineAtMs: number,
        signal?: AbortSignal,
    ): Promise<StreamAdmissionRelease> {
        if (signal?.aborted) return Promise.reject(abortReason(signal));
        if (performance.now() >= deadlineAtMs) {
            return Promise.reject(new StreamProxyDeadlineError(this.lane));
        }
        if (this.active < this.maxActive) {
            this.active += 1;
            return Promise.resolve(this.createRelease());
        }
        if (this.waiters.length >= this.maxQueued) {
            return Promise.reject(new StreamProxyCapacityError(this.lane));
        }

        return new Promise((resolve, reject) => {
            const waiter: StreamAdmissionWaiter = {
                signal,
                deadlineAtMs,
                resolve,
                reject,
                abort: () => undefined,
            };
            waiter.deadlineTimer = setTimeout(
                () =>
                    this.rejectWaiter(
                        waiter,
                        new StreamProxyDeadlineError(this.lane),
                    ),
                Math.max(1, Math.ceil(deadlineAtMs - performance.now())),
            );
            waiter.deadlineTimer.unref?.();
            waiter.abort = () => {
                this.rejectWaiter(waiter, abortReason(signal!));
            };
            this.waiters.push(waiter);
            signal?.addEventListener("abort", waiter.abort, { once: true });
            if (signal?.aborted) waiter.abort();
        });
    }

    private createRelease(): StreamAdmissionRelease {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.active -= 1;
            this.drain();
        };
    }

    private rejectWaiter(waiter: StreamAdmissionWaiter, error: Error): void {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        this.detachWaiter(waiter);
        waiter.reject(error);
    }

    private detachWaiter(waiter: StreamAdmissionWaiter): void {
        if (waiter.deadlineTimer) clearTimeout(waiter.deadlineTimer);
        waiter.signal?.removeEventListener("abort", waiter.abort);
    }

    private drain(): void {
        while (this.active < this.maxActive && this.waiters.length > 0) {
            const waiter = this.waiters.shift()!;
            this.detachWaiter(waiter);
            if (waiter.signal?.aborted) {
                waiter.reject(abortReason(waiter.signal));
                continue;
            }
            if (performance.now() >= waiter.deadlineAtMs) {
                waiter.reject(new StreamProxyDeadlineError(this.lane));
                continue;
            }
            this.active += 1;
            waiter.resolve(this.createRelease());
        }
    }
}

// Agents and admissions intentionally share module lifetime. Creating another
// service instance cannot bypass the process-wide sidecar transport bounds.
const SIDE_CAR_CONTROL_ADMISSION = new BoundedStreamAdmission(
    CONTROL_REQUEST_ACTIVE_LIMIT,
    CONTROL_REQUEST_QUEUE_LIMIT,
    "control",
);
const SIDE_CAR_INTERACTIVE_ADMISSION = new BoundedStreamAdmission(
    INTERACTIVE_STREAM_ACTIVE_LIMIT,
    INTERACTIVE_STREAM_QUEUE_LIMIT,
    "interactive",
);
const SIDE_CAR_BACKGROUND_ADMISSION = new BoundedStreamAdmission(
    BACKGROUND_STREAM_ACTIVE_LIMIT,
    BACKGROUND_STREAM_QUEUE_LIMIT,
    "background",
);

interface CompletionObservableStream {
    closed?: boolean;
    once(event: "end" | "close" | "error", listener: () => void): unknown;
    off?(event: "end" | "close" | "error", listener: () => void): unknown;
    destroy?(): unknown;
}

function holdAdmissionUntilStreamCompletion(
    value: unknown,
    completeLease: StreamAdmissionRelease,
): void {
    if (
        typeof value !== "object" ||
        value === null ||
        !("once" in value) ||
        typeof value.once !== "function"
    ) {
        completeLease();
        return;
    }
    const stream = value as CompletionObservableStream;
    let completed = false;
    const complete = () => {
        if (completed) return;
        completed = true;
        stream.off?.("close", complete);
        stream.off?.("error", onError);
        completeLease();
    };
    const onError = () => stream.destroy?.();
    stream.once("close", complete);
    stream.once("error", onError);
    if (stream.closed) complete();
}

const SIDE_CAR_STREAM_REQUEST = Symbol("sidecar-stream-request");
type SidecarStreamRequestConfig = AxiosRequestConfig & {
    [SIDE_CAR_STREAM_REQUEST]: true;
};
type SidecarInternalRequestConfig = InternalAxiosRequestConfig & {
    [SIDE_CAR_STREAM_REQUEST]?: true;
};

let baseAxiosAdapter: AxiosAdapter | undefined;

function getBaseAxiosAdapter(): AxiosAdapter {
    baseAxiosAdapter ??= axios.getAdapter(axios.defaults.adapter);
    return baseAxiosAdapter;
}

function resolveControlRequestBudgetMs(timeoutMs: number | undefined): number {
    if (
        timeoutMs === undefined ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > MAX_NODE_TIMER_DELAY_MS
    ) {
        return CONTROL_REQUEST_DEFAULT_TIMEOUT_MS;
    }
    return Math.max(1, timeoutMs);
}

interface CloseObservableRequest {
    closed?: boolean;
    once(event: "close", listener: () => void): unknown;
    off(event: "close", listener: () => void): unknown;
}

function asCloseObservableRequest(
    candidate: unknown,
): CloseObservableRequest | undefined {
    if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("once" in candidate) ||
        typeof candidate.once !== "function" ||
        !("off" in candidate) ||
        typeof candidate.off !== "function"
    ) {
        return undefined;
    }
    return candidate as CloseObservableRequest;
}

function failedRequest(error: unknown): CloseObservableRequest | undefined {
    if (!axios.isAxiosError(error)) return undefined;
    return asCloseObservableRequest(error.request);
}

async function waitForRequestTransportRelease(
    request: CloseObservableRequest,
): Promise<void> {
    if (request.closed) return;
    await new Promise<void>((resolve) => {
        const complete = () => {
            request.off("close", complete);
            resolve();
        };
        request.once("close", complete);
        if (request.closed) complete();
    });
}

function deferAdmissionReleaseUntilTransportReleased(
    request: unknown,
    release: StreamAdmissionRelease,
): boolean {
    const observableRequest = asCloseObservableRequest(request);
    if (!observableRequest) return false;
    void waitForRequestTransportRelease(observableRequest).then(release);
    return true;
}

function closeRejectedStreamingResponse(error: unknown): void {
    if (!axios.isAxiosError(error)) return;
    const responseBody = error.response?.data as unknown;
    if (
        typeof responseBody !== "object" ||
        responseBody === null ||
        !("destroy" in responseBody) ||
        typeof responseBody.destroy !== "function"
    ) {
        return;
    }
    responseBody.destroy();
}

const SIDE_CAR_BOUNDED_ADAPTER: AxiosAdapter = async (rawConfig) => {
    const requestConfig = rawConfig as SidecarInternalRequestConfig;
    // Stream responses own a longer lease through end/close/error in
    // getStreamProxy; do not consume a second control permit here.
    if (requestConfig[SIDE_CAR_STREAM_REQUEST]) {
        return getBaseAxiosAdapter()(rawConfig);
    }

    const signal = requestConfig.signal as AbortSignal | undefined;
    const deadlineAtMs =
        performance.now() +
        resolveControlRequestBudgetMs(requestConfig.timeout);
    const release = await SIDE_CAR_CONTROL_ADMISSION.acquire(
        deadlineAtMs,
        signal,
    );
    let releaseDeferred = false;
    try {
        if (signal?.aborted) throw abortReason(signal);
        const remainingTimeoutMs = Math.ceil(deadlineAtMs - performance.now());
        if (remainingTimeoutMs <= 0) {
            throw new StreamProxyDeadlineError("control");
        }
        requestConfig.timeout = remainingTimeoutMs;
        try {
            const response = await getBaseAxiosAdapter()(rawConfig);
            releaseDeferred = deferAdmissionReleaseUntilTransportReleased(
                response.request,
                release,
            );
            return response;
        } catch (error) {
            // Axios may settle before Node completes the native request close
            // callback that returns or removes its socket. Keep the permit
            // through that request-owned lifecycle without delaying the
            // caller's rejection.
            const request = failedRequest(error);
            if (request) {
                releaseDeferred = true;
                void waitForRequestTransportRelease(request).then(release);
            }
            throw error;
        }
    } finally {
        if (!releaseDeferred) release();
    }
};
const AVAILABILITY_CACHE_TTL_MS = 10_000;
const RADIO_CACHE_TTL_MS = 30_000;
const RADIO_CACHE_MAX_KEYS = 256;
// The sidecar's default YTMUSIC_BROWSE_TIMEOUT is 30 seconds. Leave margin so
// its sanitized 503/504 response reaches the backend before Axios times out.
const LIBRARY_PLAYLISTS_TIMEOUT_MS = 35_000;
const ALBUM_MATCH_BATCH_TIMEOUT_MS = 150_000;
const ALBUM_MATCH_BATCH_MAX_RETRIES = 0;
const ALBUM_MATCH_FALLBACK_CONCURRENCY = 3;
const limitAlbumMatchIndividualFallback = pLimit(
    ALBUM_MATCH_FALLBACK_CONCURRENCY,
);

// ── Types ──────────────────────────────────────────────────────────

export interface YtMusicAuthStatus {
    authenticated: boolean;
    reason?: string;
}

export interface YtMusicDeviceCode {
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
}

export interface YtMusicDeviceCodePollResult {
    status: "pending" | "success" | "error";
    error?: string | null;
    oauth_json?: string;
}

export interface YtMusicSearchResult {
    results: any[];
    total: number;
}

export interface YtMusicCanonicalSearchResponse {
    query: string;
    filter: "songs" | "albums" | "artists" | "videos" | null;
    total: number;
    results: CanonicalMediaSearchResult[];
}

/** Per-request transport policy for latency-sensitive catalog searches. */
export interface YtMusicSearchOptions {
    timeoutMs?: number;
    maxRetries?: number;
    signal?: AbortSignal;
}

/** Per-request transport policy for sidecar stream probes. */
export interface YtMusicStreamInfoOptions {
    timeoutMs?: number;
    maxRetries?: number;
    /** Read metadata from completed audio work without invoking yt-dlp. */
    cachedOnly?: boolean;
}

export type YtMusicStreamPurpose = "interactive" | "preload" | "analysis";

/** A browsable YouTube Music album returned by catalog search. */
export interface YtMusicCatalogAlbumResult {
    mediaType: "album";
    provider: "ytmusic";
    browseId: string;
    title: string;
    artistName: string;
    year: string | null;
    thumbnailUrl: string | null;
    raw: Record<string, unknown>;
}

/** A browsable YouTube Music artist returned by catalog search. */
export interface YtMusicCatalogArtistResult {
    mediaType: "artist";
    provider: "ytmusic";
    channelId: string;
    name: string;
    thumbnailUrl: string | null;
    raw: Record<string, unknown>;
}

/** Normalized non-track catalog response for albums or artists. */
export interface YtMusicCatalogSearchResponse {
    query: string;
    filter: "albums" | "artists";
    total: number;
    results: Array<YtMusicCatalogAlbumResult | YtMusicCatalogArtistResult>;
}

export interface YtMusicAlbum {
    browseId: string;
    title: string;
    artist: string;
    year?: string;
    thumbnails: any[];
    tracks: any[];
    trackCount: number;
    duration?: string;
    type: string;
}

export interface YtMusicArtist {
    channelId: string;
    name: string;
    thumbnails: any[];
    description?: string;
    albums: any[];
    songs: any[];
}

export interface YtMusicSong {
    videoId: string;
    title: string;
    artist: string;
    album?: string;
    duration?: number;
    thumbnails: any[];
}

export interface YtMusicStreamInfo {
    videoId: string;
    url: string;
    content_type: string;
    duration: number;
    abr: number;
    acodec: string;
    expires_at: number;
}

export interface YtMusicMixPreview {
    playlistId: string;
    title: string;
    description: string;
    thumbnails: Array<{ url: string; width: number }>;
    count: string | null;
}

/** One playable track returned by a provider radio queue. */
export interface YtMusicRadioTrack {
    videoId: string;
    title: string;
    artist: string;
    artists: string[];
    artistId?: string | null;
    album: string;
    albumId?: string | null;
    duration: number;
    thumbnailUrl: string | null;
}

/** Normalized public radio queue produced from one YouTube Music seed. */
export interface YtMusicRadioQueue {
    playlistId: string | null;
    seedVideoId: string;
    tracks: YtMusicRadioTrack[];
}

interface YtMusicMatchInput {
    artist: string;
    title: string;
    albumTitle?: string;
    duration?: number;
    isrc?: string;
}

/**
 * Safely extract a numeric duration (in seconds) from a YT Music result.
 * The sidecar returns `duration_seconds` (int) and `duration` (string like "3:45").
 * If `duration_seconds` is missing or 0, parse the text representation.
 */
function parseDuration(item: any): number {
    if (item.duration_seconds && typeof item.duration_seconds === "number") {
        return item.duration_seconds;
    }
    if (typeof item.duration === "number" && item.duration > 0) {
        return item.duration;
    }
    if (typeof item.duration === "string" && item.duration.includes(":")) {
        const parts = item.duration.split(":").map(Number);
        if (parts.length === 3)
            return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
    }
    return 0;
}

function normalizeText(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function resolvePrimaryArtist(item: Record<string, unknown>): string {
    const artist = normalizeText(item.artist);
    if (artist) {
        return artist;
    }

    const artists = item.artists;
    if (Array.isArray(artists)) {
        for (const entry of artists) {
            if (typeof entry === "string") {
                const normalized = normalizeText(entry);
                if (normalized) return normalized;
                continue;
            }
            if (entry && typeof entry === "object") {
                const name = normalizeText(
                    (entry as Record<string, unknown>).name,
                );
                if (name) return name;
            }
        }
    }

    return "Unknown Artist";
}

function resolveAlbumTitle(item: Record<string, unknown>): string | null {
    const album = item.album;
    if (typeof album === "string") {
        return normalizeText(album);
    }
    if (album && typeof album === "object") {
        const record = album as Record<string, unknown>;
        return normalizeText(record.title) ?? normalizeText(record.name);
    }
    return null;
}

function resolveThumbnailUrl(item: Record<string, unknown>): string | null {
    const thumbnails = item.thumbnails;
    if (!Array.isArray(thumbnails)) return null;
    let bestUrl: string | null = null;
    let bestArea = -1;
    let bestIndex = -1;
    for (const [index, thumb] of thumbnails.entries()) {
        if (!thumb || typeof thumb !== "object") continue;
        const record = thumb as Record<string, unknown>;
        const url = normalizeText(record.url);
        if (!url) continue;
        const width = typeof record.width === "number" ? record.width : 0;
        const height = typeof record.height === "number" ? record.height : 0;
        const area = width > 0 && height > 0 ? width * height : 0;
        if (area > bestArea || (area === bestArea && index > bestIndex)) {
            bestUrl = url;
            bestArea = area;
            bestIndex = index;
        }
    }
    return bestUrl;
}

/** Return true when a raw YouTube Music search item is explicitly a video. */
export function isExplicitVideoSearchResult(item: unknown): boolean {
    if (!item || typeof item !== "object") return false;
    const type = normalizeText((item as Record<string, unknown>).type);
    return type?.toLowerCase() === "video";
}

/** Normalize a raw YouTube Music song into the shared media-search contract. */
export function toCanonicalSearchResultItem(
    item: unknown,
): CanonicalMediaSearchResult | null {
    if (!item || typeof item !== "object") {
        return null;
    }

    const record = item as Record<string, unknown>;
    const providerTrackId = normalizeText(record.videoId);
    const title = normalizeText(record.title);

    if (!providerTrackId || !title) {
        return null;
    }

    const durationSecRaw = parseDuration(record);
    const durationSec =
        Number.isFinite(durationSecRaw) && durationSecRaw > 0
            ? durationSecRaw
            : null;

    return {
        source: "youtube",
        provider: "ytmusic",
        providerTrackId,
        title,
        artistName: resolvePrimaryArtist(record),
        albumTitle: resolveAlbumTitle(record),
        durationSec,
        thumbnailUrl: resolveThumbnailUrl(record),
        raw: record,
    };
}

/** Normalize a raw YouTube Music album while preserving its browse identity. */
export function toCatalogAlbumResultItem(
    item: unknown,
): YtMusicCatalogAlbumResult | null {
    if (!item || typeof item !== "object") {
        return null;
    }

    const record = item as Record<string, unknown>;
    const resultType = (
        normalizeText(record.type) ?? normalizeText(record.resultType)
    )?.toLowerCase();
    const browseId = normalizeText(record.browseId);
    const title = normalizeText(record.title);
    if (
        resultType !== "album" ||
        !browseId ||
        (!browseId.startsWith("MPRE") && !browseId.startsWith("VLOLAK5uy_")) ||
        !title
    ) {
        return null;
    }

    return {
        mediaType: "album",
        provider: "ytmusic",
        browseId,
        title,
        artistName: resolvePrimaryArtist(record),
        year: normalizeText(record.year),
        thumbnailUrl: resolveThumbnailUrl(record),
        raw: record,
    };
}

/** Normalize a raw YouTube Music artist while preserving its channel identity. */
export function toCatalogArtistResultItem(
    item: unknown,
): YtMusicCatalogArtistResult | null {
    if (!item || typeof item !== "object") {
        return null;
    }

    const record = item as Record<string, unknown>;
    const resultType = (
        normalizeText(record.type) ?? normalizeText(record.resultType)
    )?.toLowerCase();
    const channelId =
        normalizeText(record.channelId) ?? normalizeText(record.browseId);
    const name =
        normalizeText(record.artist) ??
        normalizeText(record.name) ??
        normalizeText(record.title);
    if (resultType !== "artist" || !channelId || !name) {
        return null;
    }

    return {
        mediaType: "artist",
        provider: "ytmusic",
        channelId,
        name,
        thumbnailUrl: resolveThumbnailUrl(record),
        raw: record,
    };
}

// ── Service ────────────────────────────────────────────────────────

export interface YtMusicTailWarmupRequest {
    ownerId: string;
    generation: number;
    quality: string;
    current: string | null;
    immediate: string | null;
    tail: string[];
}

export interface YtMusicTailWarmupSnapshot {
    ownerId: string;
    generation: number;
    accepted: boolean;
    items: Array<{
        videoId: string;
        quality: string;
        status: "complete" | "readable" | "queued" | "miss" | "failed";
    }>;
}

class YouTubeMusicService {
    private readonly streamInfoFlights = new Map<
        string,
        Promise<YtMusicStreamInfo>
    >();
    private readonly radioLoaders = new Map<
        string,
        CachedSingleflight<YtMusicRadioQueue>
    >();
    private client: AxiosInstance;
    private readonly loadAvailability = cachedSingleflight(async () => {
        try {
            const res = await this.client.get("/health", { timeout: 5_000 });
            return res.status === 200;
        } catch {
            return false;
        }
    }, AVAILABILITY_CACHE_TTL_MS);
    private static readonly UNDESIRED_MISMATCH_TERMS = [
        "karaoke",
        "tribute",
        "cover",
        "soundalike",
        "sound alike",
        "nightcore",
        "sped up",
        "slowed",
    ];
    private static readonly VERSION_MISMATCH_TERMS = [
        "live",
        "acoustic",
        "instrumental",
        "remix",
        "edit",
        "version",
        "re-recorded",
        "rerecorded",
    ];

    constructor() {
        this.client = axios.create({
            baseURL: YTMUSIC_STREAMER_URL,
            timeout: 30_000,
            // The sidecar is a fixed internal origin; never spend both protocol
            // pools or forward internal credentials through a redirect.
            maxRedirects: 0,
            adapter: SIDE_CAR_BOUNDED_ADAPTER,
            httpAgent: SIDE_CAR_CONTROL_HTTP_AGENT,
            httpsAgent: SIDE_CAR_CONTROL_HTTPS_AGENT,
            // Authenticate to the sidecar (F31). Omitted when unset so the
            // sidecar rejects fail-closed rather than us sending a blank header.
            ...(config.internalApiSecret
                ? { headers: { "x-internal-secret": config.internalApiSecret } }
                : {}),
        });
    }

    // ── Health / Status ────────────────────────────────────────────

    /**
     * Check whether the sidecar is reachable.
     */
    async isAvailable(): Promise<boolean> {
        return this.loadAvailability();
    }

    /**
     * Check whether a specific user is authenticated with YouTube Music.
     */
    async getAuthStatus(userId: string): Promise<YtMusicAuthStatus> {
        const res = await this.client.get("/auth/status", {
            params: { user_id: userId },
        });
        return res.data;
    }

    // ── OAuth Credential Restore ───────────────────────────────────

    /**
     * Write OAuth JSON to the sidecar for a specific user (used to restore
     * credentials from the DB on first request).
     */
    async restoreOAuth(userId: string, oauthJson: string): Promise<void> {
        await this.client.post(
            "/auth/restore",
            { oauth_json: oauthJson },
            { params: { user_id: userId } },
        );
    }

    /**
     * Clear stored OAuth credentials in the sidecar for a specific user.
     */
    async clearAuth(userId: string): Promise<void> {
        await this.client.post("/auth/clear", null, {
            params: { user_id: userId },
        });
    }

    // ── Device Code OAuth Flow ─────────────────────────────────────

    /**
     * Initiate the Google OAuth device code flow.
     * Returns a user_code and verification_url for the user to visit.
     */
    async initiateDeviceAuth(
        clientId: string,
        clientSecret: string,
    ): Promise<YtMusicDeviceCode> {
        const res = await this.client.post("/auth/device-code", {
            client_id: clientId,
            client_secret: clientSecret,
        });
        return res.data;
    }

    /**
     * Poll for device code authorization completion.
     * Returns the token when ready, or a pending status.
     */
    async pollDeviceAuth(
        userId: string,
        clientId: string,
        clientSecret: string,
        deviceCode: string,
    ): Promise<YtMusicDeviceCodePollResult> {
        const res = await this.client.post(
            "/auth/device-code/poll",
            {
                client_id: clientId,
                client_secret: clientSecret,
                device_code: deviceCode,
            },
            { params: { user_id: userId } },
        );
        return res.data;
    }

    /**
     * Restore OAuth credentials to the sidecar, including client credentials
     * for OAuthCredentials support.
     */
    async restoreOAuthWithCredentials(
        userId: string,
        oauthJson: string,
        clientId?: string,
        clientSecret?: string,
    ): Promise<void> {
        const body: Record<string, string> = { oauth_json: oauthJson };
        if (clientId && clientSecret) {
            body.client_id = clientId;
            body.client_secret = clientSecret;
        }
        await this.client.post("/auth/restore", body, {
            params: { user_id: userId },
        });
    }

    // ── Search ─────────────────────────────────────────────────────

    async search(
        userId: string,
        query: string,
        filter?: "songs" | "albums" | "artists" | "videos",
        limit?: number,
        options: YtMusicSearchOptions = {},
    ): Promise<YtMusicSearchResult> {
        return retryWithBackoff(
            async () => {
                const requestConfig = {
                    params: { user_id: userId },
                    ...(options.timeoutMs
                        ? { timeout: options.timeoutMs }
                        : {}),
                    ...(options.signal ? { signal: options.signal } : {}),
                };
                const res = await this.client.post(
                    "/search",
                    { query, filter, ...(limit ? { limit } : {}) },
                    requestConfig,
                );
                return res.data;
            },
            `search(${query})`,
            options.maxRetries ?? 3,
            1000,
            options.signal,
        );
    }

    async searchCanonical(
        userId: string,
        query: string,
        filter?: "songs" | "albums" | "artists" | "videos",
        limit?: number,
        options: YtMusicSearchOptions = {},
    ): Promise<YtMusicCanonicalSearchResponse> {
        const rawResult = await this.search(
            userId,
            query,
            filter,
            limit,
            options,
        );
        const canonicalResults = Array.isArray(rawResult.results)
            ? rawResult.results
                  .filter(
                      (item) =>
                          filter !== "songs" ||
                          !isExplicitVideoSearchResult(item),
                  )
                  .map((item) => toCanonicalSearchResultItem(item))
                  .filter(
                      (item): item is CanonicalMediaSearchResult =>
                          item !== null,
                  )
            : [];

        return {
            query,
            filter: filter ?? null,
            total:
                typeof rawResult.total === "number" &&
                Number.isFinite(rawResult.total)
                    ? rawResult.total
                    : canonicalResults.length,
            results: canonicalResults,
        };
    }

    /** Search browsable YouTube Music album or artist identities. */
    async searchCatalog(
        userId: string,
        query: string,
        filter: "albums" | "artists",
        limit?: number,
        options: YtMusicSearchOptions = {},
    ): Promise<YtMusicCatalogSearchResponse> {
        const rawResult = await this.search(
            userId,
            query,
            filter,
            limit,
            options,
        );
        const mapper =
            filter === "albums"
                ? toCatalogAlbumResultItem
                : toCatalogArtistResultItem;
        const results = Array.isArray(rawResult.results)
            ? rawResult.results
                  .map((item) => mapper(item))
                  .filter(
                      (
                          item,
                      ): item is
                          | YtMusicCatalogAlbumResult
                          | YtMusicCatalogArtistResult => item !== null,
                  )
            : [];

        return {
            query,
            filter,
            total:
                typeof rawResult.total === "number" &&
                Number.isFinite(rawResult.total)
                    ? rawResult.total
                    : results.length,
            results,
        };
    }

    // ── Browse ─────────────────────────────────────────────────────

    async getAlbum(userId: string, browseId: string): Promise<YtMusicAlbum> {
        const encodedId = encodeProviderPathSegment(browseId, "album id");
        const res = await this.client.get(`/album/${encodedId}`, {
            params: { user_id: userId },
        });
        return res.data;
    }

    async getArtist(userId: string, channelId: string): Promise<YtMusicArtist> {
        const encodedId = encodeProviderPathSegment(channelId, "artist id");
        const res = await this.client.get(`/artist/${encodedId}`, {
            params: { user_id: userId },
        });
        return res.data;
    }

    async getSong(userId: string, videoId: string): Promise<YtMusicSong> {
        const encodedId = encodeProviderPathSegment(videoId, "video id");
        const res = await this.client.get(`/song/${encodedId}`, {
            params: { user_id: userId },
        });
        return res.data;
    }

    /** Resolve metadata or read its cache; use getStreamProxy for audio. */
    async getStreamInfo(
        userId: string,
        videoId: string,
        quality?: string,
        options: YtMusicStreamInfoOptions = {},
    ): Promise<YtMusicStreamInfo> {
        const encodedId = encodeProviderPathSegment(videoId, "video id");
        const timeoutMs = options.timeoutMs || undefined;
        const maxRetries = options.maxRetries ?? 3;
        const params: Record<string, string> = { user_id: userId };
        if (quality) params.quality = quality;
        if (options.cachedOnly) params.cached_only = "true";
        // Coalesce only transport-compatible work; no settled metadata or
        // failures are cached here. Snapshot options before the deferred start.
        const key = JSON.stringify([
            userId,
            encodedId,
            quality || "",
            Boolean(options.cachedOnly),
            String(timeoutMs),
            String(maxRetries),
        ]);
        const load = () =>
            retryWithBackoff<YtMusicStreamInfo>(
                async () => {
                    const res = await this.client.get(`/stream/${encodedId}`, {
                        params,
                        ...(timeoutMs ? { timeout: timeoutMs } : {}),
                    });
                    return res.data;
                },
                `getStreamInfo(${videoId})`,
                maxRetries,
            );
        // Bound bookkeeping without changing existing overload behavior.
        // A full map still joins known keys; new keys use the normal client.
        const flight =
            this.streamInfoFlights.size >= STREAM_INFO_MAX_IN_FLIGHT &&
            !this.streamInfoFlights.has(key)
                ? load()
                : coalesceInFlightByKey(this.streamInfoFlights, key, load);
        // Stream metadata is a flat DTO: callers must not share mutable fields.
        return { ...(await flight) };
    }

    /**
     * Return an Axios response that streams the audio bytes from the
     * sidecar proxy. The caller should pipe `res.data` to the client.
     */
    async getStreamProxy(
        userId: string,
        videoId: string,
        quality?: string,
        rangeHeader?: string,
        options: {
            signal?: AbortSignal;
            timeoutMs?: number;
            purpose?: YtMusicStreamPurpose;
        } = {},
    ) {
        const encodedId = encodeProviderPathSegment(videoId, "video id");
        const purpose = options.purpose ?? "interactive";
        const isBackground = purpose !== "interactive";
        const streamAdmission = isBackground
            ? SIDE_CAR_BACKGROUND_ADMISSION
            : SIDE_CAR_INTERACTIVE_ADMISSION;
        const streamHttpAgent = isBackground
            ? SIDE_CAR_BACKGROUND_HTTP_AGENT
            : SIDE_CAR_INTERACTIVE_HTTP_AGENT;
        const streamHttpsAgent = isBackground
            ? SIDE_CAR_BACKGROUND_HTTPS_AGENT
            : SIDE_CAR_INTERACTIVE_HTTPS_AGENT;
        const requestBudgetMs = resolveStreamProxyBudgetMs(options.timeoutMs);
        const deadlineAtMs = performance.now() + requestBudgetMs;
        const params: Record<string, string> = {
            user_id: userId,
            purpose,
        };
        if (quality) params.quality = quality;

        const headers: Record<string, string> = {};
        if (rangeHeader) headers["Range"] = rangeHeader;

        const acquire = (timeoutMs: number, freshConnection = false) =>
            this.client.get(`/proxy/${encodedId}`, {
                params,
                headers,
                responseType: "stream",
                timeout: timeoutMs,
                httpAgent: freshConnection ? false : streamHttpAgent,
                httpsAgent: freshConnection ? false : streamHttpsAgent,
                ...(options.signal ? { signal: options.signal } : {}),
                [SIDE_CAR_STREAM_REQUEST]: true,
            } as SidecarStreamRequestConfig);

        const release = await streamAdmission.acquire(
            deadlineAtMs,
            options.signal,
        );
        try {
            const remainingTimeoutMs = Math.ceil(
                deadlineAtMs - performance.now(),
            );
            if (remainingTimeoutMs <= 0) {
                throw new StreamProxyDeadlineError(
                    isBackground ? "background" : "interactive",
                );
            }
            const response = await acquire(remainingTimeoutMs).catch((error: unknown) => {
                const reset = error as {
                    code?: string;
                    response?: unknown;
                    request?: { reusedSocket?: boolean };
                } | null;
                // A sidecar can close an idle keep-alive socket just as Node
                // reuses it. Retry this GET only before any response, once on
                // a fresh connection, within the same admission and deadline.
                if (reset?.code !== "ECONNRESET" || reset.response ||
                    reset.request?.reusedSocket !== true || options.signal?.aborted) {
                    throw error;
                }
                const remaining = Math.ceil(deadlineAtMs - performance.now());
                if (remaining <= 0) throw error;
                logger.warn("Retrying reset reused sidecar audio connection", { videoId, purpose });
                return acquire(remaining, true);
            });
            holdAdmissionUntilStreamCompletion(response.data, () => {
                if (
                    !deferAdmissionReleaseUntilTransportReleased(
                        response.request,
                        release,
                    )
                ) {
                    release();
                }
            });
            return response;
        } catch (error) {
            closeRejectedStreamingResponse(error);
            const request = failedRequest(error);
            if (
                !request ||
                !deferAdmissionReleaseUntilTransportReleased(request, release)
            ) {
                release();
            }
            throw error;
        }
    }

    /** Reconcile server-side warm interests without returning audio bytes. */
    async reconcileTailWarmup(
        request: YtMusicTailWarmupRequest,
        options: { signal?: AbortSignal } = {},
    ): Promise<YtMusicTailWarmupSnapshot> {
        const response = await this.client.post(
            "/tail-warmup/reconcile",
            request,
            {
                ...(options.signal ? { signal: options.signal } : {}),
                timeout: 5_000,
            },
        );
        return response.data;
    }

    // ── Library ────────────────────────────────────────────────────

    async getLibrarySongs(userId: string, limit = 100): Promise<any[]> {
        const res = await this.client.get("/library/songs", {
            params: { user_id: userId, limit },
        });
        return res.data.songs;
    }

    async getLibraryAlbums(userId: string, limit = 100): Promise<any[]> {
        const res = await this.client.get("/library/albums", {
            params: { user_id: userId, limit },
        });
        return res.data.albums;
    }

    /**
     * Get user's library playlists from YouTube Music.
     * When mixesOnly is true, filters to auto-generated/personalized mixes only.
     */
    async getLibraryPlaylists(
        userId: string,
        limit = 25,
        mixesOnly = false,
    ): Promise<YtMusicMixPreview[]> {
        const res = await this.client.get("/library/playlists", {
            params: { user_id: userId, limit, mixes_only: mixesOnly },
            timeout: LIBRARY_PLAYLISTS_TIMEOUT_MS,
        });
        return res.data.playlists ?? [];
    }

    // ── Gap-Fill Matching ──────────────────────────────────────────

    /**
     * Run multiple search queries against the sidecar concurrently.
     * The sidecar executes all queries in parallel via asyncio.gather,
     * so N queries take ~1 round-trip instead of N sequential ones.
     */
    async searchBatch(
        userId: string,
        queries: Array<{
            query: string;
            filter?: "songs" | "albums" | "artists" | "videos";
            limit?: number;
        }>,
        options: YtMusicSearchOptions = {},
    ): Promise<Array<{ results: any[]; total: number; error: string | null }>> {
        return retryWithBackoff(
            async () => {
                const res = await this.client.post(
                    "/search/batch",
                    { queries },
                    {
                        params: { user_id: userId },
                        timeout: options.timeoutMs ?? 60_000,
                        ...(options.signal ? { signal: options.signal } : {}),
                    },
                );
                return res.data.results;
            },
            `searchBatch(${queries.length} queries)`,
            options.maxRetries ?? 3,
            1000,
            options.signal,
        );
    }

    /**
     * Match an entire album's tracks against YouTube Music in one
     * batch call. Instead of N individual match requests (each doing
     * up to 3 search fallbacks), this:
     *   1. Sends all search queries in a single batch to the sidecar
     *   2. Runs them concurrently on the sidecar via asyncio.gather
     *   3. Returns matches keyed by track index
     *
     * Falls back to individual matching for tracks that didn't match
     * in the filtered batch.
     */
    async findMatchesForAlbum(
        userId: string,
        tracks: YtMusicMatchInput[],
    ): Promise<
        Array<{ videoId: string; title: string; duration: number } | null>
    > {
        // Step 1: Build filtered "songs" search queries for all tracks
        const queries = tracks.map((t) => {
            const cleanArtist = this.sanitizeQuery(t.artist);
            const cleanTitle = this.sanitizeQuery(t.title);
            return {
                query: `${cleanArtist} ${cleanTitle}`,
                filter: "songs" as const,
                limit: 6,
            };
        });

        // Step 2: Execute all queries concurrently in one batch call
        let batchResults: Array<{
            results: any[];
            total: number;
            error: string | null;
        }>;
        try {
            batchResults = await this.searchBatch(userId, queries, {
                timeoutMs: ALBUM_MATCH_BATCH_TIMEOUT_MS,
                maxRetries: ALBUM_MATCH_BATCH_MAX_RETRIES,
            });
        } catch (err) {
            logger.warn(
                "[YTMusic] Batch search failed, falling back to individual:",
                err,
            );
            // Fallback: match each track individually
            return await Promise.all(
                tracks.map((t) =>
                    limitAlbumMatchIndividualFallback(() =>
                        this.findMatchForTrack(
                            userId,
                            t.artist,
                            t.title,
                            t.albumTitle,
                            t.duration,
                            t.isrc,
                        ),
                    ),
                ),
            );
        }

        // Step 3: Extract matches from batch results
        const matches: Array<{
            videoId: string;
            title: string;
            duration: number;
        } | null> = [];
        const unmatchedIndices: number[] = [];

        for (let i = 0; i < tracks.length; i++) {
            const result = batchResults[i];
            if (result && !result.error && result.results?.length) {
                const sourceTrack = tracks[i];
                if (!sourceTrack) {
                    matches.push(null);
                    unmatchedIndices.push(i);
                    continue;
                }

                const song = this.selectBestCandidate(
                    sourceTrack,
                    result.results,
                );
                if (song) {
                    matches.push(this.toMatchResult(song, sourceTrack.title));
                    continue;
                }
            }
            // No match from filtered search — try unfiltered fallback
            matches.push(null);
            unmatchedIndices.push(i);
        }

        // Step 4: For unmatched tracks, try unfiltered search in a second batch
        if (unmatchedIndices.length > 0) {
            const fallbackQueries = unmatchedIndices.map((idx) => {
                const t = tracks[idx];
                const cleanArtist = this.sanitizeQuery(t.artist);
                const cleanTitle = this.sanitizeQuery(t.title);
                // Try with album title for disambiguation
                const cleanAlbum = t.albumTitle
                    ? this.sanitizeQuery(t.albumTitle)
                    : "";
                const query = cleanAlbum
                    ? `${cleanArtist} ${cleanTitle} ${cleanAlbum}`
                    : `${cleanArtist} ${cleanTitle}`;
                return { query, limit: 8 };
            });

            try {
                const fallbackResults = await this.searchBatch(
                    userId,
                    fallbackQueries,
                    {
                        timeoutMs: ALBUM_MATCH_BATCH_TIMEOUT_MS,
                        maxRetries: ALBUM_MATCH_BATCH_MAX_RETRIES,
                    },
                );
                for (let j = 0; j < unmatchedIndices.length; j++) {
                    const idx = unmatchedIndices[j];
                    const result = fallbackResults[j];
                    if (result && !result.error && result.results?.length) {
                        const sourceTrack = tracks[idx];
                        if (!sourceTrack) continue;
                        const song = this.selectBestCandidate(
                            sourceTrack,
                            result.results,
                        );
                        if (song) {
                            matches[idx] = this.toMatchResult(
                                song,
                                sourceTrack.title,
                            );
                        }
                    }
                }
            } catch (err) {
                logger.warn("[YTMusic] Batch fallback search failed:", err);
                // Leave unmatched tracks as null
            }
        }

        return matches;
    }

    /**
     * Sanitize a search query for YouTube Music.
     * Strips characters that cause HTTP 400 from Google's API:
     * parentheses, brackets, featuring tags, remaster suffixes, etc.
     */
    private sanitizeQuery(text: string): string {
        return text
            .replace(/\s*\(.*?\)\s*/g, " ") // Remove (Deluxe Edition), (feat. X), etc.
            .replace(/\s*\[.*?\]\s*/g, " ") // Remove [Remastered], [Explicit], etc.
            .replace(/[^\p{L}\p{N}\s'-]/gu, " ") // Keep letters, numbers, spaces, hyphens, apostrophes
            .replace(/\s+/g, " ") // Collapse whitespace
            .trim();
    }

    private normaliseLoose(text: string): string {
        return this.sanitizeQuery(text || "")
            .toLowerCase()
            .replace(/['\u2019]/g, "")
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    private normaliseCompact(text: string): string {
        return this.normaliseLoose(text).replace(/\s+/g, "");
    }

    private tokenOverlapScore(a: string, b: string): number {
        if (!a || !b) return 0;
        const aTokens = new Set(a.split(" ").filter(Boolean));
        const bTokens = new Set(b.split(" ").filter(Boolean));
        if (!aTokens.size || !bTokens.size) return 0;
        let intersection = 0;
        for (const token of aTokens) {
            if (bTokens.has(token)) intersection++;
        }
        const union = new Set([...aTokens, ...bTokens]).size;
        return union > 0 ? intersection / union : 0;
    }

    private textSimilarity(expected: string, candidate: string): number {
        const lhs = this.normaliseLoose(expected);
        const rhs = this.normaliseLoose(candidate);
        if (!lhs || !rhs) return 0;
        if (lhs === rhs) return 1;

        const lhsCompact = lhs.replace(/\s+/g, "");
        const rhsCompact = rhs.replace(/\s+/g, "");
        if (lhsCompact === rhsCompact) return 0.98;

        const overlap = this.tokenOverlapScore(lhs, rhs);
        const containsBonus = lhs.includes(rhs) || rhs.includes(lhs) ? 0.1 : 0;
        return Math.min(1, overlap * 0.9 + containsBonus);
    }

    private hasTerm(text: string, term: string): boolean {
        return this.normaliseLoose(text).includes(term);
    }

    private mismatchPenalty(
        expectedTitle: string,
        candidateTitle: string,
    ): number {
        let penalty = 0;

        for (const term of YouTubeMusicService.UNDESIRED_MISMATCH_TERMS) {
            if (
                !this.hasTerm(expectedTitle, term) &&
                this.hasTerm(candidateTitle, term)
            ) {
                penalty += 0.25;
            }
        }

        for (const term of YouTubeMusicService.VERSION_MISMATCH_TERMS) {
            if (
                !this.hasTerm(expectedTitle, term) &&
                this.hasTerm(candidateTitle, term)
            ) {
                penalty += 0.08;
            }
        }

        return Math.min(0.45, penalty);
    }

    private normaliseDurationSeconds(value?: number): number | null {
        if (
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            value <= 0
        ) {
            return null;
        }
        const seconds =
            value > 10_000 ? Math.round(value / 1000) : Math.round(value);
        if (seconds <= 0 || seconds > 6 * 60 * 60) return null;
        return seconds;
    }

    private durationSimilarity(
        expected?: number,
        candidate?: number,
    ): number | null {
        const expectedSeconds = this.normaliseDurationSeconds(expected);
        const candidateSeconds = this.normaliseDurationSeconds(candidate);
        if (expectedSeconds === null || candidateSeconds === null) return null;

        const diff = Math.abs(expectedSeconds - candidateSeconds);
        if (diff <= 3) return 1;
        if (diff <= 7) return 0.9;
        if (diff <= 15) return 0.65;
        if (diff <= 30) return 0.35;
        return 0;
    }

    private extractCandidateArtists(candidate: any): string[] {
        const fromPrimary =
            typeof candidate?.artist === "string" && candidate.artist.trim()
                ? [candidate.artist]
                : [];
        const fromList = Array.isArray(candidate?.artists)
            ? candidate.artists.filter(
                  (artist: unknown) =>
                      typeof artist === "string" && artist.trim(),
              )
            : [];
        return Array.from(new Set([...fromPrimary, ...fromList]));
    }

    private extractCandidateAlbum(candidate: any): string {
        if (typeof candidate?.album === "string") return candidate.album;
        if (typeof candidate?.album?.name === "string")
            return candidate.album.name;
        if (typeof candidate?.album?.title === "string")
            return candidate.album.title;
        return "";
    }

    private scoreCandidate(track: YtMusicMatchInput, candidate: any): number {
        const titleScore = this.textSimilarity(
            track.title,
            candidate?.title || "",
        );
        const artistCandidates = this.extractCandidateArtists(candidate);
        const artistScore = artistCandidates.length
            ? Math.max(
                  ...artistCandidates.map((artistName) =>
                      this.textSimilarity(track.artist, artistName),
                  ),
              )
            : this.textSimilarity(track.artist, candidate?.artist || "");
        const albumScore =
            track.albumTitle && this.extractCandidateAlbum(candidate)
                ? this.textSimilarity(
                      track.albumTitle,
                      this.extractCandidateAlbum(candidate),
                  )
                : null;
        const durationScore = this.durationSimilarity(
            track.duration,
            parseDuration(candidate),
        );

        const weightedSignals: Array<{ score: number; weight: number }> = [
            { score: titleScore, weight: 0.56 },
            { score: artistScore, weight: 0.32 },
        ];
        if (albumScore !== null)
            weightedSignals.push({ score: albumScore, weight: 0.12 });
        if (durationScore !== null)
            weightedSignals.push({ score: durationScore, weight: 0.2 });

        const totalWeight = weightedSignals.reduce(
            (sum, entry) => sum + entry.weight,
            0,
        );
        let score =
            totalWeight > 0
                ? weightedSignals.reduce(
                      (sum, entry) => sum + entry.score * entry.weight,
                      0,
                  ) / totalWeight
                : 0;
        score -= this.mismatchPenalty(track.title, candidate?.title || "");

        if (candidate?.type && candidate.type !== "song") {
            score -= 0.25;
        }

        if (
            this.normaliseCompact(track.title) ===
            this.normaliseCompact(candidate?.title || "")
        ) {
            score += 0.08;
        }

        if (
            artistCandidates.some(
                (artistName) =>
                    this.normaliseCompact(track.artist) ===
                    this.normaliseCompact(artistName),
            )
        ) {
            score += 0.05;
        }

        return score;
    }

    private selectBestCandidate(
        track: YtMusicMatchInput,
        candidates: any[],
    ): any | null {
        const viable = candidates.filter((candidate) => !!candidate?.videoId);
        if (!viable.length) return null;

        const ranked = viable
            .map((candidate) => ({
                candidate,
                score: this.scoreCandidate(track, candidate),
            }))
            .sort((a, b) => b.score - a.score);

        const best = ranked[0];
        const second = ranked[1];
        if (!best) return null;

        if (best.score < 0.54) return null;
        if (second && best.score < 0.64 && best.score - second.score < 0.07) {
            return null;
        }

        return best.candidate;
    }

    private toMatchResult(
        candidate: any,
        fallbackTitle: string,
    ): { videoId: string; title: string; duration: number } {
        return {
            videoId: candidate.videoId,
            title: candidate.title || fallbackTitle,
            duration: parseDuration(candidate),
        };
    }

    /**
     * Find a matching YouTube Music track for an album track that
     * isn't in the local library. Searches by "{artist} {title}" and
     * ranks candidates by title/artist/album/duration similarity.
     *
     * Uses a tiered fallback strategy:
     *   1. artist + title (filtered to songs)
     *   2. artist + title (unfiltered)
     *   3. artist + title + album (unfiltered)
     */
    async findMatchForTrack(
        userId: string,
        artist: string,
        title: string,
        albumTitle?: string,
        duration?: number,
        isrc?: string,
        options: YtMusicSearchOptions = {},
    ): Promise<{ videoId: string; title: string; duration: number } | null> {
        const cleanArtist = this.sanitizeQuery(artist);
        const cleanTitle = this.sanitizeQuery(title);
        const shortQuery = `${cleanArtist} ${cleanTitle}`;
        const sourceTrack: YtMusicMatchInput = {
            artist: cleanArtist,
            title: cleanTitle,
            albumTitle,
            duration,
            isrc,
        };

        // --- Attempt 1: filtered search (songs only) ---
        try {
            const result = await this.search(
                userId,
                shortQuery,
                "songs",
                undefined,
                options,
            );
            if (result.results?.length) {
                const match = this.selectBestCandidate(
                    sourceTrack,
                    result.results,
                );
                if (match) return this.toMatchResult(match, title);
            }
        } catch (error) {
            if (options.signal?.aborted) throw error;
            // Filtered search failed (HTTP 400) — fall through
        }

        // --- Attempt 2: unfiltered search, pick first song ---
        try {
            const result = await this.search(
                userId,
                shortQuery,
                undefined,
                undefined,
                options,
            );
            const song = this.selectBestCandidate(
                sourceTrack,
                result.results || [],
            );
            if (song) return this.toMatchResult(song, title);
        } catch (error) {
            if (options.signal?.aborted) throw error;
            // Unfiltered search also failed — fall through
        }

        // --- Attempt 3: add album title for disambiguation ---
        if (albumTitle) {
            const cleanAlbum = this.sanitizeQuery(albumTitle);
            const longQuery = `${cleanArtist} ${cleanTitle} ${cleanAlbum}`;
            try {
                const result = await this.search(
                    userId,
                    longQuery,
                    undefined,
                    undefined,
                    options,
                );
                const song = this.selectBestCandidate(
                    { ...sourceTrack, albumTitle: cleanAlbum },
                    result.results || [],
                );
                if (song) return this.toMatchResult(song, title);
            } catch (err) {
                if (options.signal?.aborted) throw err;
                logger.warn(
                    `[YTMusic] All search attempts failed for "${artist} - ${title}":`,
                    err,
                );
            }
        }

        return null;
    }

    /**
     * Find another exact recording and prove that it is streamable before the
     * player switches provider identity. Probes are sequential and capped so
     * one broken search page cannot fan out sidecar extraction work.
     */
    async findPlayableAlternateForTrack(
        userId: string,
        input: YtMusicPlayableAlternateInput,
    ): Promise<YtMusicPlayableAlternate | null> {
        return findPlayableYtMusicAlternate(
            {
                searchSongs: (requestUserId, query, limit, options) =>
                    this.searchCanonical(
                        requestUserId,
                        query,
                        "songs",
                        limit,
                        options,
                    ),
                probeStream: (requestUserId, videoId, options) =>
                    this.getStreamInfo(
                        requestUserId,
                        videoId,
                        undefined,
                        options,
                    ),
            },
            userId,
            input,
        );
    }

    // ── Browse (unauthenticated) ─────────────────────────────────

    async getCharts(
        country: string = "US",
        userId?: string,
    ): Promise<Record<string, any[]>> {
        const { data } = await this.client.get("/charts", {
            params: { country, ...(userId ? { user_id: userId } : {}) },
            timeout: 15_000,
        });
        return data;
    }

    async getMoodCategories(userId?: string): Promise<
        Array<{
            title: string;
            items: Array<{ title: string; params: string }>;
        }>
    > {
        const { data } = await this.client.get("/moods-and-genres", {
            params: userId ? { user_id: userId } : {},
            timeout: 15_000,
        });
        return data;
    }

    async getHome(
        limit: number = 6,
        userId?: string,
    ): Promise<
        Array<{
            title: string;
            contents: Array<{
                playlistId?: string;
                videoId?: string;
                browseId?: string;
                type?: string;
                title: string;
                thumbnailUrl: string | null;
                subtitle: string;
            }>;
        }>
    > {
        const { data } = await this.client.get("/home", {
            params: { limit, ...(userId ? { user_id: userId } : {}) },
            timeout: 15_000,
        });
        return data;
    }

    /** Load a bounded public radio queue for one provider track. */
    async getRadio(
        videoId: string,
        limit: number = 25,
    ): Promise<YtMusicRadioQueue> {
        const normalizedVideoId = videoId.trim();
        const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
        const cacheKey = `${normalizedVideoId}:${boundedLimit}`;
        let loader = this.radioLoaders.get(cacheKey);
        if (!loader) {
            loader = cachedSingleflight(async () => {
                const { data } = await this.client.get("/radio", {
                    params: {
                        video_id: normalizedVideoId,
                        limit: boundedLimit,
                    },
                    timeout: 13_000,
                });
                return data;
            }, RADIO_CACHE_TTL_MS);
            if (this.radioLoaders.size >= RADIO_CACHE_MAX_KEYS) {
                const oldestKey = this.radioLoaders.keys().next().value;
                if (oldestKey !== undefined)
                    this.radioLoaders.delete(oldestKey);
            }
            this.radioLoaders.set(cacheKey, loader);
        }
        return loader();
    }

    async getMoodPlaylists(
        params: string,
        userId?: string,
    ): Promise<
        Array<{
            playlistId: string;
            title: string;
            thumbnailUrl: string | null;
            author: string;
        }>
    > {
        const { data } = await this.client.get("/mood-playlists", {
            params: { params, ...(userId ? { user_id: userId } : {}) },
            timeout: 15_000,
        });
        return data;
    }

    async getBrowsePlaylist(
        playlistId: string,
        limit: number = 100,
        userId?: string,
    ): Promise<{
        id: string;
        title: string;
        description: string;
        trackCount: number;
        thumbnailUrl: string | null;
        tracks: Array<{
            videoId: string;
            title: string;
            artist: string;
            artists: string[];
            album: string;
            duration: number;
            thumbnailUrl: string | null;
        }>;
    }> {
        const encodedId = encodeProviderPathSegment(playlistId, "playlist id");
        const { data } = await this.client.get(`/playlist/${encodedId}`, {
            params: { limit, ...(userId ? { user_id: userId } : {}) },
            timeout: 15_000,
        });
        return data;
    }

    /**
     * Fetch album details from the sidecar's public browse-album endpoint.
     */
    async getBrowseAlbum(browseId: string): Promise<{
        browseId: string;
        title: string;
        artist: string;
        artists: string[];
        year: string | null;
        trackCount: number;
        duration: string | null;
        type: string;
        thumbnails: Array<{ url: string; width: number; height: number }>;
        coverUrl: string | null;
        tracks: Array<{
            videoId: string;
            title: string;
            artist: string;
            artists: string[];
            trackNumber: number | null;
            duration: string | null;
            duration_seconds: number | null;
            isExplicit: boolean;
            likeStatus: string | null;
        }>;
        description: string | null;
    }> {
        const encodedId = encodeProviderPathSegment(browseId, "album id");
        const { data } = await this.client.get(`/browse-album/${encodedId}`, {
            timeout: 15_000,
        });
        return data;
    }
}

export const ytMusicService = new YouTubeMusicService();
