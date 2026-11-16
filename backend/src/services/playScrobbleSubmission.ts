import axios, { type AxiosRequestConfig } from "axios";
import { createLastFmApiSignature } from "./scrobbleSigning";
import {
    decodeScrobbleDispatchAck,
    scrobbleDispatchTrackSchema,
    type ScrobbleDispatchAck,
} from "./playScrobbleProtocol";
import type { ScrobbleService, ScrobbleTrack } from "./scrobbleTypes";

const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
const LISTENBRAINZ_SUBMIT_URL = "https://api.listenbrainz.org/1/submit-listens";
const timeoutMs = 8_000;

/** Only failures proven before invoking transport can return to PENDING. */
export class ScrobbleBeforeHandoffError extends Error {
    constructor(
        readonly reason: "configuration_unavailable" | "metadata_invalid",
    ) {
        super(reason);
        this.name = "ScrobbleBeforeHandoffError";
    }
}

/** Ephemeral submission data: credentials never enter an intent or wakeup payload. */
export interface ScrobbleDispatchSubmission {
    service: ScrobbleService;
    credential: string;
    listenedAtSeconds: number;
    track: ScrobbleTrack;
    lastFm?: { apiKey: string; sharedSecret: string };
}

/** Transport seam permits a real local TLS peer without overriding runtime endpoints. */
export interface ScrobbleDispatchTransport {
    post(
        url: string,
        data: unknown,
        options: AxiosRequestConfig,
    ): Promise<{ status: number; data: unknown }>;
}

/** One invocation makes at most one HTTP handoff; transport errors remain unknown. */
export function createScrobbleDispatchSubmitter(
    transport: ScrobbleDispatchTransport = axios,
) {
    return async (
        input: ScrobbleDispatchSubmission,
    ): Promise<ScrobbleDispatchAck> => {
        const track = scrobbleDispatchTrackSchema.safeParse(input.track);
        if (
            !track.success ||
            !Number.isSafeInteger(input.listenedAtSeconds) ||
            input.listenedAtSeconds <= 0
        ) {
            throw new ScrobbleBeforeHandoffError("metadata_invalid");
        }
        if (!input.credential)
            throw new ScrobbleBeforeHandoffError("configuration_unavailable");
        let url: string;
        let body: unknown;
        let headers: Record<string, string> | undefined;
        if (input.service === "listenbrainz") {
            url = LISTENBRAINZ_SUBMIT_URL;
            headers = { Authorization: `Token ${input.credential}` };
            body = {
                listen_type: "single",
                payload: [
                    {
                        listened_at: input.listenedAtSeconds,
                        track_metadata: {
                            artist_name: track.data.artist,
                            track_name: track.data.title,
                            ...(track.data.album
                                ? { release_name: track.data.album }
                                : {}),
                            ...(track.data.durationSeconds !== undefined
                                ? {
                                      additional_info: {
                                          duration_ms:
                                              track.data.durationSeconds * 1000,
                                      },
                                  }
                                : {}),
                        },
                    },
                ],
            };
        } else {
            if (!input.lastFm?.apiKey || !input.lastFm.sharedSecret)
                throw new ScrobbleBeforeHandoffError(
                    "configuration_unavailable",
                );
            url = LASTFM_API_URL;
            const parameters: Record<string, string> = {
                method: "track.scrobble",
                api_key: input.lastFm.apiKey,
                sk: input.credential,
                artist: track.data.artist,
                track: track.data.title,
                timestamp: String(input.listenedAtSeconds),
                ...(track.data.album ? { album: track.data.album } : {}),
                ...(track.data.durationSeconds !== undefined
                    ? { duration: String(track.data.durationSeconds) }
                    : {}),
            };
            body = new URLSearchParams({
                ...parameters,
                api_sig: createLastFmApiSignature(
                    parameters,
                    input.lastFm.sharedSecret,
                ),
                format: "json",
            });
        }
        // From this exact invocation onward, an exception cannot prove no external accept.
        try {
            const response = await transport.post(url, body, {
                headers,
                timeout: timeoutMs,
                signal: AbortSignal.timeout(timeoutMs),
                validateStatus: () => true,
                maxRedirects: 0,
                maxContentLength: 65_536,
                maxBodyLength: 65_536,
                responseType: "json",
            });
            return decodeScrobbleDispatchAck(
                input.service,
                response.status,
                response.data,
            );
        } catch {
            return "ambiguous";
        }
    };
}
