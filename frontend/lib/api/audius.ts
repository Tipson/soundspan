import { z } from "zod";
import type { ApiClientConstructor } from "./core";
import {
    audiusTrackSchema,
    validateAudiusPlaybackUrl,
    type AudiusCatalogTrack,
} from "../audio/audiusPlayback";

/** Authenticated metadata stays at Soundspan; public audio carries no app credentials. */
export function WithAudius<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class AudiusApi extends Base {
        /** Search the opt-in catalog; no implicit cross-provider matching or retries. */
        async searchAudius(
            query: string,
            signal?: AbortSignal,
        ): Promise<AudiusCatalogTrack[]> {
            const params = new URLSearchParams({ query, limit: "20" });
            const response = await this.request(`/audius/search?${params}`, {
                signal,
                timeoutMs: 10_000,
                retryOnTimeout: false,
            });
            return z
                .object({
                    source: z.literal("audius"),
                    tracks: z.array(audiusTrackSchema).max(20),
                })
                .parse(response).tracks;
        }
        /** Revalidate full-stream access immediately before handing a public URL to audio. */
        async resolveAudiusPlayback(
            id: string,
            signal?: AbortSignal,
        ): Promise<string> {
            if (!/^[A-Za-z0-9]{3,32}$/.test(id))
                throw new Error("Некорректный трек Audius");
            const response = await this.request(
                `/audius/tracks/${id}/playback`,
                { signal, timeoutMs: 10_000, retryOnTimeout: false },
            );
            return validateAudiusPlaybackUrl(id, response);
        }
    }
    return AudiusApi;
}
