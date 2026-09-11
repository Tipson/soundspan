import type { ApiClientConstructor } from "./core";

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
/** Administrative source management through the shared authenticated API boundary. */
export function WithMusicSources<TBase extends ApiClientConstructor>(
    Base: TBase,
) {
    abstract class MusicSourcesApi extends Base {
        async getMusicSourceConnections(): Promise<{
            connections: MusicSourceConnectionStatus[];
            health: {
                activeStreams: Record<string, number>;
                circuits: Array<{
                    connection: string;
                    until: number;
                    code: string;
                }>;
            };
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
