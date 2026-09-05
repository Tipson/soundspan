import axios from "axios";
import { z } from "zod";
import { isAllowedAudiusStreamUrl } from "@soundspan/media-metadata-contract";
import {
    AudiusStreamUnavailableError,
    awaitAudiusDeadline,
    resolveAudiusStreamRedirect,
} from "./audiusStream";
import { resolveSafeOutboundUrl } from "./outboundUrlSafety";

const API_ORIGIN = "https://api.audius.co/v1";
const TRACK_ID = /^[A-Za-z0-9]{3,32}$/;
const MAX_ACTIVE_REQUESTS = 4;
const REQUEST_TIMEOUT_MS = 8_000;

/** Independent catalog entry; never an inferred replacement for another recording. */
export interface AudiusTrack {
    source: "audius";
    id: string;
    title: string;
    artist: string;
    artistHandle: string;
    artistVerified: boolean;
    durationSeconds: number;
    attributionUrl: string;
    fullStreamAvailable: true;
    automaticFallbackEligible: false;
    downloadAllowed: false;
}

/** Sanitized provider error that can cross the application API boundary. */
export class AudiusError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "AudiusError";
    }
}

function text(value: unknown, maximum: number): string | null {
    return typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= maximum
        ? value.trim()
        : null;
}

const trackSchema = z.object({
    id: z.string().regex(TRACK_ID),
    title: z.string().trim().min(1).max(300),
    duration: z.number().positive().max(86_400),
    is_streamable: z.literal(true),
    is_stream_gated: z.literal(false),
    is_unlisted: z.literal(false),
    is_delete: z.literal(false),
    stream_conditions: z.null().optional(),
    access: z.object({ stream: z.literal(true) }),
    permalink: z
        .string()
        .max(600)
        .regex(/^\/[A-Za-z0-9_.-]+\/[^\s?#\\]+$/),
    user: z.object({
        name: z.string().trim().min(1).max(200),
        handle: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[A-Za-z0-9_.-]+$/),
        is_verified: z.boolean().optional(),
    }),
});
const envelopeSchema = z.object({ data: z.unknown() });
const searchResultsSchema = z.array(z.unknown()).max(100);

/** Require affirmative full-stream access and safe attribution from official metadata. */
export function normalizeAudiusTrack(value: unknown): AudiusTrack | null {
    const parsed = trackSchema.safeParse(value);
    if (!parsed.success) return null;
    const track = parsed.data;
    return {
        source: "audius",
        id: track.id,
        title: track.title,
        artist: track.user.name,
        artistHandle: track.user.handle,
        artistVerified: track.user.is_verified === true,
        durationSeconds: track.duration,
        attributionUrl: `https://audius.co${track.permalink}`,
        fullStreamAvailable: true,
        automaticFallbackEligible: false,
        downloadAllowed: false,
    };
}

/** Narrow transport seam for deterministic contract tests. */
export type AudiusMetadataRequest = (
    path: string,
    signal: AbortSignal,
    mode?: "metadata" | "stream-location",
) => Promise<unknown>;

const client = axios.create({
    baseURL: API_ORIGIN,
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
    maxContentLength: 1_048_576,
    maxBodyLength: 0,
    proxy: false,
    responseType: "json",
    headers: { Accept: "application/json" },
});

const defaultRequest: AudiusMetadataRequest = async (path, signal, mode) => {
    if (mode === "stream-location") {
        return { data: await resolveAudiusStreamRedirect(path, signal) };
    }
    const safeUrl = await awaitAudiusDeadline(
        resolveSafeOutboundUrl(`${API_ORIGIN}${path}`),
        signal,
    );
    if (!safeUrl) throw new Error("Unsafe Audius API destination");
    signal.throwIfAborted();
    const response = await client.get<unknown>(safeUrl, { signal });
    return response.data;
};

/** Bounded public metadata adapter; streams stay on Audius' official HTTPS endpoint. */
export class AudiusService {
    private active = 0;
    private cooldownUntil = 0;

    constructor(
        private readonly request: AudiusMetadataRequest = defaultRequest,
    ) {}

    private async load(
        path: string,
        signal?: AbortSignal,
        mode: "metadata" | "stream-location" = "metadata",
    ): Promise<unknown> {
        if (signal?.aborted)
            throw new AudiusError(
                "Request cancelled or timed out",
                signal.reason?.name === "TimeoutError" ? 502 : 499,
            );
        if (
            this.active >= MAX_ACTIVE_REQUESTS ||
            Date.now() < this.cooldownUntil
        ) {
            throw new AudiusError(
                "Audius capacity is temporarily unavailable",
                503,
            );
        }
        this.active += 1;
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
            const payload = envelopeSchema.safeParse(
                await this.request(path, combined, mode),
            );
            if (!payload.success) {
                throw new AudiusError("Audius returned invalid metadata", 502);
            }
            return payload.data.data;
        } catch (error) {
            if (signal?.aborted)
                throw new AudiusError(
                    "Request cancelled or timed out",
                    signal.reason?.name === "TimeoutError" ? 502 : 499,
                );
            if (error instanceof AudiusError) throw error;
            if (error instanceof AudiusStreamUnavailableError) {
                if (error.status === 429)
                    this.cooldownUntil = Date.now() + 30_000;
                throw new AudiusError(
                    error.message,
                    error.status === 429 ? 503 : 422,
                );
            }
            if (axios.isAxiosError(error) && error.response?.status === 429) {
                this.cooldownUntil = Date.now() + 30_000;
                throw new AudiusError(
                    "Audius capacity is temporarily unavailable",
                    503,
                );
            }
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                throw new AudiusError("Audius track was not found", 404);
            }
            throw new AudiusError("Audius is temporarily unavailable", 502);
        } finally {
            this.active -= 1;
        }
    }

    /** Search only Audius; reject inaccessible tracks and preserve exact artist/version text. */
    async search(
        query: string,
        limit = 10,
        signal?: AbortSignal,
    ): Promise<AudiusTrack[]> {
        const normalized = text(query, 200);
        if (
            !normalized ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 20
        ) {
            throw new AudiusError(
                "Query must contain 1–200 characters and limit must be 1–20",
                400,
            );
        }
        const params = new URLSearchParams({
            query: normalized,
            limit: String(limit),
            app_name: "Soundspan",
        });
        const entries = searchResultsSchema.safeParse(
            await this.load(`/tracks/search?${params}`, signal),
        );
        if (!entries.success)
            throw new AudiusError("Audius returned invalid metadata", 502);
        return entries.data
            .map(normalizeAudiusTrack)
            .filter((entry): entry is AudiusTrack => entry !== null)
            .slice(0, limit);
    }

    /** Recheck full access on every playback request and construct a fixed-origin stream URL. */
    async resolveStream(id: string, signal?: AbortSignal): Promise<string> {
        if (!TRACK_ID.test(id))
            throw new AudiusError("Invalid Audius track id", 400);
        const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const sharedSignal = signal
            ? AbortSignal.any([signal, deadline])
            : deadline;
        const entry = await this.load(
            `/tracks/${id}?app_name=Soundspan`,
            sharedSignal,
        );
        const track = normalizeAudiusTrack(entry);
        if (!track || track.id !== id) {
            throw new AudiusError(
                "Audius full stream is not available for this track",
                422,
            );
        }
        const location = await this.load(
            `/tracks/${id}/stream?app_name=Soundspan`,
            sharedSignal,
            "stream-location",
        );
        if (!isAllowedAudiusStreamUrl(location)) {
            throw new AudiusError(
                "Audius selected an unsupported media node",
                422,
            );
        }
        return location;
    }
}

/** Process-wide adapter shares its admission bound and provider cooldown. */
export const audiusService = new AudiusService();
