import type { ApiClientConstructor } from "./core";
import { z } from "zod";

/** Server-owned direct playback provider. */
export type MusicSourceProvider = "yandex" | "vk";
/** Redacted administrator-visible connection state. */
export interface MusicSourceConnectionStatus {
    provider: MusicSourceProvider;
    configured: boolean;
    enabled: boolean;
    version: number;
    updatedAt?: string;
}
/** Aggregate transport operations for a provider, without account or track identifiers. */
export interface MusicSourceUsage {
    resolutionAttempts: number;
    selected: number;
    noMatch: number;
    resolutionFailed: number;
    resolutionCancelled: number;
    streamRequests: number;
    streamCompleted: number;
    streamFailed: number;
    streamCancelled: number;
    lastFailure: string | null;
}
/** Administrator diagnostics for the current playback API process. */
export interface MusicSourceHealth {
    activeStreams: Record<string, number>;
    circuits: Array<{ connection: string; until: number; code: string }>;
    usage?: {
        since: number;
        providers: Partial<Record<MusicSourceProvider, MusicSourceUsage>>;
    };
}
/** Metadata only; transport URLs and credentials remain on the server. */
export interface MusicSourceCandidate {
    provider: MusicSourceProvider;
    id: string;
    title: string;
    artists: string[];
    duration: number;
    contentVersion: "explicit" | "clean" | "unknown";
    isrc?: string;
    preview: boolean;
}
/** Original recording identity, independent of the provider carrying its audio. */
export type MusicSourceRecording = Pick<
    MusicSourceCandidate,
    "title" | "artists" | "duration" | "contentVersion" | "isrc"
>;

const recoveryResponse = z.object({
    playback: z
        .object({
            leaseId: z.string().regex(/^[a-f0-9]{48}$/),
            provider: z.enum(["yandex", "vk"]),
            streamPath: z.string(),
        })
        .nullable(),
});
/** Administrative source management through the shared authenticated API boundary. */
export function WithMusicSources<TBase extends ApiClientConstructor>(
    Base: TBase,
) {
    abstract class MusicSourcesApi extends Base {
        /** Request one exact replacement without retrying or changing catalog identity. */
        async resolveMusicSourceForRecovery(
            recording: MusicSourceRecording,
            signal?: AbortSignal,
        ): Promise<string | null> {
            const response = await this.request("/music-sources/resolve", {
                method: "POST",
                body: JSON.stringify(recording),
                signal,
                timeoutMs: 20_000,
                retryOnTimeout: false,
            });
            const { playback } = recoveryResponse.parse(response);
            if (!playback) return null;
            const path = `/api/music-sources/leases/${playback.leaseId}/stream`;
            if (playback.streamPath !== path)
                throw new Error("Invalid recovery stream");
            return path;
        }
        async getMusicSourceConnections(): Promise<{
            connections: MusicSourceConnectionStatus[];
            health: MusicSourceHealth;
        }> {
            return this.request("/music-sources/connections");
        }
        async saveMusicSourceConnection(
            provider: MusicSourceProvider,
            input: { token?: string; enabled: boolean },
        ): Promise<{ saved: boolean }> {
            return this.request(`/music-sources/connections/${provider}`, {
                method: "PUT",
                body: JSON.stringify(input),
                retryOnTimeout: false,
            });
        }
        async searchMusicSource(
            provider: MusicSourceProvider,
            query: string,
        ): Promise<{ tracks: MusicSourceCandidate[] }> {
            return this.request(
                `/music-sources/search?${new URLSearchParams({ provider, query })}`,
                { retryOnTimeout: false },
            );
        }
        async resolveMusicSource(candidate: MusicSourceCandidate): Promise<{
            playback: {
                leaseId: string;
                provider: MusicSourceProvider;
                streamPath: string;
            } | null;
        }> {
            const { provider, title, artists, duration, contentVersion, isrc } =
                candidate;
            return this.request("/music-sources/resolve", {
                method: "POST",
                body: JSON.stringify({
                    provider,
                    title,
                    artists,
                    duration,
                    contentVersion,
                    ...(isrc ? { isrc } : {}),
                }),
                retryOnTimeout: false,
            });
        }
    }
    return MusicSourcesApi;
}
