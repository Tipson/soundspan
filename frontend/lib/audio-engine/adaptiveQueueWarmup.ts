import type { AudioPreloadLease } from "@/lib/audio-engine/types";

export interface NetworkConnectionHints {
    saveData?: boolean | null;
    effectiveType?: string | null;
}

export type AdaptiveTailWarmupCount = 0 | 2 | 4;

/** Conservative when Network Information API is unavailable; never guesses 4. */
export function resolveAdaptiveTailWarmupCount(
    connection: NetworkConnectionHints,
): AdaptiveTailWarmupCount {
    if (connection.saveData) {
        return 0;
    }
    switch (connection.effectiveType?.trim().toLowerCase()) {
        case "slow-2g":
        case "2g":
            return 0;
        case "4g":
            return 4;
        case "3g":
        default:
            return 2;
    }
}

export interface WarmupQueueItem {
    id: string;
    itemType?: string;
}

/**
 * Returns the contiguous, distinct music suffix in real playback order.
 * Crossing an episode would speculate beyond a different media session, so it
 * deliberately stops instead of skipping that item.
 */
export function resolveUpcomingQueueTracks<T extends WarmupQueueItem>(
    queue: readonly T[],
    currentIndex: number,
    isShuffle: boolean,
    shuffleIndices: readonly number[],
    repeatMode: "off" | "one" | "all",
    limit: number,
): T[] {
    if (
        queue.length < 2 ||
        repeatMode === "one" ||
        !Number.isInteger(currentIndex) ||
        currentIndex < 0 ||
        currentIndex >= queue.length ||
        !Number.isFinite(limit) ||
        limit <= 0
    ) {
        return [];
    }

    const order = isShuffle
        ? shuffleIndices.filter(
              (index, position, values) =>
                  Number.isInteger(index) &&
                  index >= 0 &&
                  index < queue.length &&
                  values.indexOf(index) === position,
          )
        : queue.map((_, index) => index);
    const currentOrderIndex = order.indexOf(currentIndex);
    if (currentOrderIndex < 0) {
        return [];
    }

    const result: T[] = [];
    const maximum = Math.min(Math.floor(limit), queue.length - 1);
    for (
        let offset = 1;
        offset <= queue.length && result.length < maximum;
        offset += 1
    ) {
        const orderIndex = currentOrderIndex + offset;
        if (orderIndex >= order.length && repeatMode !== "all") {
            break;
        }
        const queueIndex = order[orderIndex % order.length];
        if (queueIndex === undefined || queueIndex === currentIndex) {
            break;
        }
        const item = queue[queueIndex];
        if (!item || item.itemType === "episode") {
            break;
        }
        result.push(item);
    }
    return result;
}

export interface TailWarmupReconcileRequest {
    ownerId: string;
    generation: number;
    quality?: string;
    current: string | null;
    immediate: string | null;
    tail: string[];
}

export type TailWarmupReconciler = (
    request: TailWarmupReconcileRequest,
    signal: AbortSignal,
) => Promise<unknown>;

export interface AdaptiveQueueWarmupInput {
    quality?: string;
    currentVideoId: string | null;
    immediateVideoId: string | null;
    tailVideoIds: readonly string[];
    connection: NetworkConnectionHints;
    immediateLease: AudioPreloadLease | null;
}

/**
 * Serializes the two-phase contract: priority interests first, adaptive tail
 * only after the browser's immediate-next media lease is actually ready.
 */
export class AdaptiveQueueWarmupCoordinator {
    private generation = 0;
    private controller: AbortController | null = null;

    constructor(
        private readonly ownerId: string,
        private readonly reconciler: TailWarmupReconciler,
        private readonly onError: (error: unknown) => void = () => undefined,
    ) {}

    reconcile(input: AdaptiveQueueWarmupInput): Promise<void> {
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        const generation = ++this.generation;
        const baseRequest: TailWarmupReconcileRequest = {
            ownerId: this.ownerId,
            generation,
            ...(input.quality ? { quality: input.quality } : {}),
            current: input.currentVideoId,
            immediate: input.immediateVideoId,
            tail: [],
        };
        const prioritySubmission = this.submit(baseRequest, controller);

        return (async () => {
            const readiness = input.immediateLease
                ? await input.immediateLease.result
                : { state: "cancelled" as const };
            await prioritySubmission;
            if (
                readiness.state !== "ready" ||
                controller.signal.aborted ||
                this.controller !== controller ||
                this.generation !== generation
            ) {
                return;
            }
            const tailCount = resolveAdaptiveTailWarmupCount(input.connection);
            if (tailCount === 0) {
                return;
            }
            const reserved = new Set(
                [input.currentVideoId, input.immediateVideoId].filter(
                    (value): value is string => Boolean(value),
                ),
            );
            const tail = input.tailVideoIds
                .filter((videoId, index, values) => {
                    const normalized = videoId.trim();
                    return (
                        normalized.length > 0 &&
                        !reserved.has(normalized) &&
                        values.indexOf(videoId) === index
                    );
                })
                .slice(0, tailCount);
            if (tail.length === 0) {
                return;
            }
            await this.submit({ ...baseRequest, tail }, controller);
        })();
    }

    clear(): Promise<void> {
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        const generation = ++this.generation;
        return this.submit(
            {
                ownerId: this.ownerId,
                generation,
                current: null,
                immediate: null,
                tail: [],
            },
            controller,
        );
    }

    dispose(): void {
        void this.clear();
    }

    private async submit(
        request: TailWarmupReconcileRequest,
        controller: AbortController,
    ): Promise<void> {
        try {
            await this.reconciler(request, controller.signal);
        } catch (error) {
            if (!controller.signal.aborted) {
                this.onError(error);
            }
        }
    }
}
