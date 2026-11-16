import type {
    MoodBucketMix,
    MoodBucketPreset,
    MoodMixParams,
    MoodPreset,
    MoodType,
    SavedMoodMixResponse,
} from "../api";
import {
    hasApiErrorStatus,
    type ApiClientConstructor,
    type ApiData,
} from "./core";
import {
    parseQueueAdmissionResponse,
    snapshotQueueAdmissionReferences,
    RECOMMENDATION_QUEUE_ADMISSION_TIMEOUT_MS,
    type FiniteQueueAdmissionReference,
    type RecommendationQueueAdmissionResult,
} from "../audio/recommendationQueueAdmission";
import { getRecommendationSessionId } from "../recommendationSession";
import {
    buildOriginalRadioContinuationPath,
    type OriginalRadioContinuationRequest,
    type OriginalRadioContinuationResponse,
} from "../radio/originalRadioContinuation";
import {
    PERSONALIZED_HOME_REQUEST_TIMEOUT_MS,
    PERSONALIZED_HOME_TIMEOUT_RETRY,
} from "@/features/home/personalizedHomeRequestPolicy";

/** Add recommendation-domain operations to an API client base class. */
export function WithRecommendations<TBase extends ApiClientConstructor>(
    Base: TBase,
) {
    abstract class RecommendationsApi extends Base {
        /** Read server admission for a finite ordered set without inferring client identities. */
        async readmitRecommendationQueue(
            references: readonly FiniteQueueAdmissionReference[],
            signal?: AbortSignal,
        ): Promise<RecommendationQueueAdmissionResult> {
            const snapshot = snapshotQueueAdmissionReferences(references);
            if (!snapshot || signal?.aborted) return { status: "unavailable" };
            return new Promise((resolve) => {
                const controller = new AbortController();
                let finished = false;
                const finish = (result: RecommendationQueueAdmissionResult) => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                    resolve(result);
                };
                const onAbort = () => {
                    controller.abort();
                    finish({ status: "unavailable" });
                };
                const timer = setTimeout(
                    onAbort,
                    RECOMMENDATION_QUEUE_ADMISSION_TIMEOUT_MS,
                );
                signal?.addEventListener("abort", onAbort, { once: true });
                try {
                    void this.request<unknown>(
                        "/personalized/queue-admission",
                        {
                            method: "POST",
                            body: JSON.stringify({ references: snapshot }),
                            signal: controller.signal,
                            timeoutMs:
                                RECOMMENDATION_QUEUE_ADMISSION_TIMEOUT_MS,
                            retryOnTimeout: false,
                            silent404: true,
                            _assertSession: () => {
                                if (controller.signal.aborted)
                                    throw new DOMException(
                                        "Admission request retired",
                                        "AbortError",
                                    );
                            },
                        },
                    ).then(
                        (value) => {
                            const response = parseQueueAdmissionResponse(
                                value,
                                snapshot,
                            );
                            finish(
                                response
                                    ? { status: "ready", response }
                                    : { status: "unavailable" },
                            );
                        },
                        (error: unknown) =>
                            finish({
                                status: hasApiErrorStatus(error, 404)
                                    ? "legacy_exact"
                                    : "unavailable",
                            }),
                    );
                } catch {
                    finish({ status: "unavailable" });
                }
            });
        }

        /** Continues the authenticated owner's original station with bounded queue exclusions. */
        async getRadioContinuation(
            input: OriginalRadioContinuationRequest,
        ): Promise<OriginalRadioContinuationResponse> {
            return this.request<OriginalRadioContinuationResponse>(
                buildOriginalRadioContinuationPath(
                    input.origin,
                    input.queue,
                    input.cursor,
                    input.limit,
                    input.sessionId,
                ),
                {
                    timeoutMs: PERSONALIZED_HOME_REQUEST_TIMEOUT_MS,
                    retryOnTimeout: PERSONALIZED_HOME_TIMEOUT_RETRY,
                },
            );
        }
        async reportRecommendationImpressions(
            generationId: string,
            tracks: Array<{
                provider: "youtube" | "tidal" | "library" | "vk" | "yandex";
                providerTrackId: string;
            }>,
        ): Promise<{ recorded: number }> {
            return this.request<{ recorded: number }>(
                "/personalized/impressions",
                {
                    method: "POST",
                    body: JSON.stringify({ generationId, tracks }),
                },
            );
        }

        // Recommendations
        async getRecommendationsForYou(limit = 10) {
            return this.request<{ artists: ApiData[] }>(
                `/recommendations/for-you?limit=${limit}`,
            );
        }

        async getSimilarArtists(seedArtistId: string, limit = 20) {
            return this.request<{ recommendations: ApiData[] }>(
                `/recommendations?seedArtistId=${seedArtistId}&limit=${limit}`,
            );
        }

        async getSimilarAlbums(seedAlbumId: string, limit = 20) {
            return this.request<{ recommendations: ApiData[] }>(
                `/recommendations/albums?seedAlbumId=${seedAlbumId}&limit=${limit}`,
            );
        }

        async getSimilarTracks(
            seedTrackId: string,
            limit = 20,
            artist?: string,
            title?: string,
        ) {
            const params = new URLSearchParams({
                seedTrackId,
                limit: String(limit),
            });
            if (artist) params.set("artist", artist);
            if (title) params.set("title", title);
            return this.request<{ recommendations: ApiData[] }>(
                `/recommendations/tracks?${params.toString()}`,
            );
        }

        async getPlayerRelated(
            seedTrackId: string,
            limit = 12,
            artist?: string,
            title?: string,
        ) {
            const params = new URLSearchParams({
                seedTrackId,
                limit: String(limit),
                sessionId: getRecommendationSessionId(),
            });
            if (artist) params.set("artist", artist);
            if (title) params.set("title", title);
            return this.request<{
                tracks: ApiData[];
                artists: ApiData[];
                albums: ApiData[];
                degradedSources: string[];
            }>(`/player/related?${params.toString()}`);
        }

        // Programmatic Mixes
        async getMixes() {
            return this.request<ApiData[]>("/mixes");
        }

        async getMix(id: string) {
            return this.request<ApiData>(`/mixes/${id}`);
        }

        async refreshMixes() {
            return this.request<{ message: string; mixes: ApiData[] }>(
                "/mixes/refresh",
                {
                    method: "POST",
                },
            );
        }

        async saveMixAsPlaylist(mixId: string, customName?: string) {
            return this.request<{
                id: string;
                name: string;
                trackCount: number;
            }>(`/mixes/${mixId}/save`, {
                method: "POST",
                body: customName
                    ? JSON.stringify({ name: customName })
                    : undefined,
            });
        }

        // Mood on Demand (Legacy)
        async getMoodPresets() {
            return this.request<MoodPreset[]>("/mixes/mood/presets");
        }

        async generateMoodMix(params: MoodMixParams) {
            return this.request<ApiData>("/mixes/mood", {
                method: "POST",
                body: JSON.stringify(params),
            });
        }

        // New Mood Bucket System (simplified, pre-computed)
        async getMoodBucketPresets() {
            return this.request<MoodBucketPreset[]>(
                "/mixes/mood/buckets/presets",
            );
        }

        async getMoodBucketMix(mood: MoodType) {
            return this.request<MoodBucketMix>(`/mixes/mood/buckets/${mood}`);
        }

        async saveMoodBucketMix(mood: MoodType) {
            return this.request<SavedMoodMixResponse>(
                `/mixes/mood/buckets/${mood}/save`,
                { method: "POST" },
            );
        }

        async backfillMoodBuckets() {
            return this.request<{
                success: boolean;
                processed: number;
                assigned: number;
            }>("/mixes/mood/buckets/backfill", { method: "POST" });
        }
    }
    return RecommendationsApi;
}
