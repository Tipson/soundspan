import type { AddToPlaylistRef } from "../trackRef";
import { type ApiClientConstructor, type ApiData } from "./core";

/** Product surface that started a tracked play. */
export type PlayContext =
    | "wave"
    | "home"
    | "search"
    | "playlist"
    | "album"
    | "artist"
    | "library";

/** Direction selected for the personal Wave feed. */
export type PlayWaveMode = "for-you" | "new" | "familiar";

/** Optional recommendation metadata attached when a play is created. */
export interface PlayRecommendationContext {
    playContext?: PlayContext;
    waveMode?: PlayWaveMode;
    recommendationGenerationId?: string;
    recommendationSessionId?: string;
}

/** Typed payload accepted by the play-history endpoint. */
export type PlayLogInput = AddToPlaylistRef & PlayRecommendationContext;

/** Minimum play record returned to the playback tracker. */
export interface PlayLogResponse {
    id: string;
}

/** Final client-observed result used by the recommendation ranker. */
export interface PlayEngagementInput {
    listenedSeconds: number;
    completionRatio: number;
    outcome: "meaningful" | "completed" | "skipped" | "failed";
}

/** Idempotent engagement update response. */
export interface PlayEngagementResponse {
    success: true;
    stale?: boolean;
}

/** Add play-history operations to an API client base class. */
export function WithPlays<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class PlaysApi extends Base {
        // Play tracking
        async logPlay(
            trackRef: AddToPlaylistRef,
            context: PlayRecommendationContext = {},
        ): Promise<PlayLogResponse> {
            return this.request<PlayLogResponse>("/plays", {
                method: "POST",
                body: JSON.stringify({ ...trackRef, ...context }),
            });
        }

        async updatePlayEngagement(
            playId: string,
            input: PlayEngagementInput,
        ): Promise<PlayEngagementResponse> {
            return this.request<PlayEngagementResponse>(
                `/plays/${encodeURIComponent(playId)}/engagement`,
                {
                    method: "PATCH",
                    body: JSON.stringify(input),
                },
            );
        }

        async getRecentPlays(limit = 50) {
            return this.request<ApiData[]>(`/plays?limit=${limit}`);
        }

        async getPlayHistorySummary() {
            return this.request<{
                allTime: number;
                last7Days: number;
                last30Days: number;
                last365Days: number;
            }>("/plays/summary");
        }

        async clearPlayHistory(range: "7d" | "30d" | "365d" | "all") {
            return this.request<{
                success: boolean;
                range: "7d" | "30d" | "365d" | "all";
                deletedCount: number;
            }>(`/plays/history?range=${range}`, {
                method: "DELETE",
            });
        }

        // Playback State (cross-device sync)
        async getPlaybackState() {
            return this.request<ApiData>("/playback-state", {
                headers: {
                    "X-Playback-Device-Id": this.getPlaybackDeviceId(),
                },
            });
        }

        async savePlaybackState(state: {
            playbackType: string;
            trackId?: string;
            audiobookId?: string;
            podcastId?: string;
            queue?: ApiData[];
            currentIndex?: number;
            isShuffle?: boolean;
            isPlaying?: boolean;
            currentTime?: number;
        }) {
            return this.request<ApiData>("/playback-state", {
                method: "POST",
                headers: {
                    "X-Playback-Device-Id": this.getPlaybackDeviceId(),
                },
                body: JSON.stringify(state),
            });
        }

        async clearPlaybackState() {
            return this.request<void>("/playback-state", {
                method: "DELETE",
                headers: {
                    "X-Playback-Device-Id": this.getPlaybackDeviceId(),
                },
            });
        }
    }
    return PlaysApi;
}
