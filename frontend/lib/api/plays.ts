import type { PlayTrackRef } from "../playTrackRef";
import { type ApiClientConstructor, type ApiData } from "./core";
import {
    PlaybackStateCoordinator,
    readPlaybackStateRevision,
    type PlaybackStateAuthority,
    type PlaybackStateInput,
    type PlaybackStateSnapshot,
} from "./playbackStateCoordinator";

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
export type PlayLogInput = PlayTrackRef & PlayRecommendationContext;

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
        private playbackStateCoordinator: PlaybackStateCoordinator | null =
            null;

        private playbackCoordinator(): PlaybackStateCoordinator {
            const authGeneration = this.getSessionGeneration();
            const deviceId = this.getPlaybackDeviceId();
            if (
                this.playbackStateCoordinator?.authGeneration ===
                    authGeneration &&
                this.playbackStateCoordinator.deviceId === deviceId
            )
                return this.playbackStateCoordinator;
            this.playbackStateCoordinator?.retire();
            const current = () =>
                this.getSessionGeneration() === authGeneration &&
                this.getPlaybackDeviceId() === deviceId;
            this.playbackStateCoordinator = new PlaybackStateCoordinator(
                authGeneration,
                deviceId,
                current,
                () => this.getPlaybackStateSnapshot(),
                async (kind, revision, state) => {
                    let nextRevision: PlaybackStateSnapshot["revision"] = null;
                    const response = await this.request<ApiData>(
                        "/playback-state",
                        {
                            method: kind === "save" ? "POST" : "DELETE",
                            headers: {
                                "X-Playback-Device-Id": deviceId,
                                "If-Match": revision.etag,
                            },
                            body:
                                kind === "save"
                                    ? JSON.stringify(state)
                                    : undefined,
                            onResponse: ({ headers }) => {
                                nextRevision = readPlaybackStateRevision(
                                    headers,
                                    authGeneration,
                                    deviceId,
                                );
                            },
                        },
                    );
                    return { state: response, revision: nextRevision };
                },
            );
            return this.playbackStateCoordinator;
        }
        // Play tracking
        async logPlay(
            trackRef: PlayTrackRef,
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

        /** Read the payload without granting authority to overwrite a newer slot. */
        async getPlaybackState() {
            return (await this.getPlaybackStateSnapshot()).state;
        }

        /** Read a device snapshot with the immutable revision of that exact read. */
        async getPlaybackStateSnapshot(): Promise<PlaybackStateSnapshot> {
            const coordinator = this.playbackCoordinator();
            const sequence = ++coordinator.readSequence;
            const epoch = coordinator.writeEpoch;
            let revision: PlaybackStateSnapshot["revision"] = null;
            const state = await this.request<ApiData>("/playback-state", {
                headers: {
                    "X-Playback-Device-Id": coordinator.deviceId,
                },
                onResponse: ({ headers }) => {
                    revision = readPlaybackStateRevision(
                        headers,
                        coordinator.authGeneration,
                        coordinator.deviceId,
                    );
                },
            });
            const snapshot = Object.freeze({ state, revision });
            coordinator.acceptRead(sequence, epoch, snapshot);
            return snapshot;
        }

        /** Coalesce pending progress; a conflict retires this semantic authority. */
        savePlaybackState(
            state: PlaybackStateInput,
            authority?: PlaybackStateAuthority,
        ) {
            return this.playbackCoordinator().save(state, authority);
        }

        /** Clear explicitly, or condition automatic cleanup on the captured read. */
        clearPlaybackState(snapshot?: PlaybackStateSnapshot) {
            return this.playbackCoordinator().clear(snapshot);
        }
    }
    return PlaysApi;
}
