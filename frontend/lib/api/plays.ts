import type { PlayTrackRef } from "../playTrackRef";
import {
    admitPlayCreateGrant,
    projectPlayCreatePayload,
    readPlayCreateGrant,
    readPlayCreateKey,
    type PlayCreateBinding,
    type PlayCreateGrant,
    type PlayCreatePayload,
} from "../playCreateJournal";
import { preparePlayCreateOwner } from "../playCreateOwner";
import { suspendPlayCreateJournalHistory } from "../playCreateJournalBridge";
import {
    readPlayCreateAck,
    readPlayEngagementAck,
    type PlayCreateWireAck,
} from "../playCreateWire";
import {
    SupersededAuthSessionError,
    type ApiClientConstructor,
    type ApiData,
} from "./core";

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

/** Revalidate the immutable persisted projection before using its exact wire bytes. */
function readFrozenPayload(payload: PlayCreatePayload): string | null {
    try {
        if (
            !Object.isFrozen(payload) ||
            Reflect.ownKeys(payload).length !== 2 ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(payload))
        )
            return null;
        const source = Object.getOwnPropertyDescriptor(payload, "source"),
            wire = Object.getOwnPropertyDescriptor(payload, "wireJson");
        if (
            !source ||
            !("value" in source) ||
            !wire ||
            !("value" in wire) ||
            typeof wire.value !== "string" ||
            wire.value.length > 65_536 ||
            new TextEncoder().encode(wire.value).byteLength > 65_536
        )
            return null;
        const projected = projectPlayCreatePayload(JSON.parse(wire.value));
        return projected &&
            projected.source === source.value &&
            projected.wireJson === wire.value
            ? projected.wireJson
            : null;
    } catch {
        return null;
    }
}

/** Add play-history operations to an API client base class. */
export function WithPlays<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class PlaysApi extends Base {
        private assertPlayCreateBinding(binding: PlayCreateBinding): void {
            if (
                typeof binding.loginNonce !== "string" ||
                binding.loginNonce.length === 0 ||
                this.getSessionGeneration() !== binding.authGeneration ||
                this.getPlayCreateLoginNonce() !== binding.loginNonce
            )
                throw new SupersededAuthSessionError();
        }

        /** Read a fresh online owner and capability; restoration alone never authorizes a POST. */
        async getPlayCreationGrant(options: {
            network: { isOnline(): boolean; getGeneration(): number };
            signal?: AbortSignal;
        }): Promise<PlayCreateGrant | null> {
            const controller = new AbortController();
            const outerSignal = options.signal;
            const abort = () => controller.abort(outerSignal?.reason);
            if (outerSignal?.aborted) return null;
            outerSignal?.addEventListener("abort", abort, { once: true });
            const current = (binding: PlayCreateBinding): boolean =>
                !controller.signal.aborted &&
                options.network.isOnline() &&
                options.network.getGeneration() === binding.networkGeneration &&
                this.getSessionGeneration() === binding.authGeneration &&
                this.getPlayCreateLoginNonce() === binding.loginNonce;
            try {
                const binding = await preparePlayCreateOwner(
                    {
                        api: this,
                        network: options.network,
                        readFreshOwner: (signal) =>
                            this.request<unknown>("/auth/me", {
                                signal,
                                cache: "no-store",
                                retryOnTimeout: false,
                                _retryCount: 1,
                                _authSessionGeneration:
                                    this.getSessionGeneration(),
                                silent404: true,
                            }),
                    },
                    { signal: controller.signal },
                );
                if (!binding || !current(binding)) return null;
                const { data, receipt } =
                    await this.requestWithReceipt<unknown>("/system/features", {
                        signal: controller.signal,
                        retryOnTimeout: false,
                        _retryCount: 1,
                        _authSessionGeneration: binding.authGeneration,
                        _assertSession: () =>
                            this.assertPlayCreateBinding(binding),
                        silent404: true,
                    });
                if (
                    !current(binding) ||
                    receipt.status !== 200 ||
                    !receipt.privateNoStore ||
                    !data ||
                    typeof data !== "object" ||
                    Array.isArray(data)
                )
                    return null;
                const grant = readPlayCreateGrant(
                    Object.getOwnPropertyDescriptor(data, "playCreation")
                        ?.value,
                    binding,
                    receipt.receivedMonotonicMs,
                );
                return grant &&
                    admitPlayCreateGrant(grant, {
                        binding,
                        online: current(binding),
                        nowMonotonicMs: performance.now(),
                        intent: { kind: "restore" },
                    }) &&
                    current(binding)
                    ? grant
                    : null;
            } catch {
                return null;
            } finally {
                outerSignal?.removeEventListener("abort", abort);
            }
        }

        /** Send one durable creation reservation with at most one same-body auth replay. */
        async createPlayIdempotent(
            key: string,
            payload: PlayCreatePayload,
            options: { binding: PlayCreateBinding; signal?: AbortSignal },
        ): Promise<PlayCreateWireAck> {
            const binding = { ...options.binding };
            this.assertPlayCreateBinding(binding);
            const wireJson = readFrozenPayload(payload);
            if (!readPlayCreateKey(key) || !wireJson)
                throw new Error("Invalid Play creation request");
            try {
                const { data } = await this.requestWithReceipt<unknown>(
                    "/plays/idempotent",
                    {
                        method: "POST",
                        body: `{"clientPlaybackId":${JSON.stringify(key)},${wireJson.slice(1)}`,
                        signal: options.signal ?? new AbortController().signal,
                        retryOnTimeout: false,
                        _retryCount: 1,
                        _authSessionGeneration: binding.authGeneration,
                        _assertSession: () =>
                            this.assertPlayCreateBinding(binding),
                    },
                );
                this.assertPlayCreateBinding(binding);
                const ack = readPlayCreateAck(data, key);
                if (!ack)
                    throw new Error("Invalid Play creation acknowledgement");
                return ack;
            } catch (error) {
                this.assertPlayCreateBinding(binding);
                if (error instanceof SyntaxError)
                    throw new Error("Invalid Play creation acknowledgement");
                throw error;
            }
        }

        /** Deliver absolute engagement for a known Play under its original login fence. */
        async updatePlayEngagementIdempotent(
            playId: string,
            input: PlayEngagementInput,
            options: { binding: PlayCreateBinding; signal?: AbortSignal },
        ): Promise<PlayEngagementResponse> {
            const binding = { ...options.binding };
            this.assertPlayCreateBinding(binding);
            try {
                const { data } = await this.requestWithReceipt<unknown>(
                    `/plays/${encodeURIComponent(playId)}/engagement`,
                    {
                        method: "PATCH",
                        body: JSON.stringify(input),
                        signal: options.signal ?? new AbortController().signal,
                        retryOnTimeout: false,
                        _retryCount: 1,
                        _authSessionGeneration: binding.authGeneration,
                        _assertSession: () =>
                            this.assertPlayCreateBinding(binding),
                    },
                );
                this.assertPlayCreateBinding(binding);
                const ack = readPlayEngagementAck(data);
                if (!ack)
                    throw new Error("Invalid Play engagement acknowledgement");
                return ack;
            } catch (error) {
                this.assertPlayCreateBinding(binding);
                if (error instanceof SyntaxError)
                    throw new Error("Invalid Play engagement acknowledgement");
                throw error;
            }
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
            const finish = suspendPlayCreateJournalHistory(this);
            let succeeded = false;
            try {
                const result = await this.request<{
                    success: boolean;
                    range: "7d" | "30d" | "365d" | "all";
                    deletedCount: number;
                }>(`/plays/history?range=${range}`, { method: "DELETE" });
                succeeded = result?.success === true;
                return result;
            } finally {
                finish(succeeded);
            }
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
