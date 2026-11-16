"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Track } from "@/lib/audio-state-context";
import { isEpisodeQueueItem, type QueueItem } from "@/lib/queue-item";
import { frontendLogger } from "@/lib/logger";
import { createMigratingStorageKey } from "@/lib/storage-migration";
import { RECOMMENDATION_FEEDBACK_STORAGE_SUFFIX } from "@/lib/playback-state-cadence";
import {
    getQueueReplacementGeneration,
    isPlaybackFailureSupersededByManualIntent,
} from "@/lib/audio-engine/playbackAdvanceOrigin";
import {
    notifyRecommendationFeedbackChange,
    registerRecommendationFeedbackOwner,
} from "./recommendationFeedbackBridge";
import {
    RecommendationQueueFeedback,
    recommendationScopeForTrack,
    type RecommendationFeedbackQueue,
    type RecommendationFeedbackIntent,
} from "./recommendationQueueFeedback";

const storageKey = createMigratingStorageKey(
    RECOMMENDATION_FEEDBACK_STORAGE_SUFFIX,
).current;
const log = frontendLogger.child("RecommendationQueueFeedback");

/** Mounted owner access; none of these methods controls current audio. */
export interface RecommendationQueueFeedbackAccess {
    allows: (track: QueueItem) => boolean;
    reset: () => void;
    pruneFuture: (
        queue: RecommendationFeedbackQueue,
    ) => RecommendationFeedbackQueue;
    revision: number;
}

interface FeedbackOwnerInput extends RecommendationFeedbackQueue {
    currentTrack: Track | null;
    publish: (queue: RecommendationFeedbackQueue) => void;
    isCurrent: () => boolean;
    isCollaborative: () => boolean;
}

function restoreGuard(): RecommendationQueueFeedback {
    if (typeof window === "undefined") return new RecommendationQueueFeedback();
    let raw: string | null;
    try {
        raw = localStorage.getItem(storageKey);
    } catch {
        log.warn("Recommendation checkpoint storage is unavailable");
        return new RecommendationQueueFeedback();
    }
    if (raw === null) return new RecommendationQueueFeedback();
    try {
        return RecommendationQueueFeedback.fromCheckpoint(JSON.parse(raw));
    } catch {
        return RecommendationQueueFeedback.fromCheckpoint({ invalid: true });
    }
}

// Undefined means no recommended tail; null means its authority is ambiguous.
function uniqueFutureScope(
    input: RecommendationFeedbackQueue,
): string | null | undefined {
    if (input.currentIndex < 0 || input.currentIndex >= input.queue.length)
        return null;
    const position = input.isShuffle
        ? input.shuffleIndices.indexOf(input.currentIndex)
        : -1;
    if (input.isShuffle && position < 0) return null;
    const future = input.isShuffle
        ? input.shuffleIndices.slice(position + 1)
        : input.queue
              .slice(input.currentIndex + 1)
              .map((_, offset) => input.currentIndex + 1 + offset);
    const scopes = new Set<string>();
    for (const index of future) {
        const item = input.queue[index];
        if (!item || isEpisodeQueueItem(item)) continue;
        const scope = recommendationScopeForTrack(item);
        if (scope) scopes.add(scope);
        if (scopes.size > 1) return null;
    }
    return scopes.size === 1 ? [...scopes][0] : undefined;
}

/** Owner-local feedback effects, evaluated against the latest committed queue.
 * The caller supplies real auth/storage fences and preserves manual/group
 * authority. Storage failures cannot prevent a preference request or playback.
 */
export function useRecommendationQueueFeedback({
    queue,
    currentIndex,
    isShuffle,
    shuffleIndices,
    currentTrack,
    publish,
    isCurrent,
    isCollaborative,
}: FeedbackOwnerInput): RecommendationQueueFeedbackAccess {
    const [guard] = useState(restoreGuard);
    const restoredScope = useMemo(() => {
        const checkpoint = guard.toCheckpoint();
        const scopes = new Set([
            ...checkpoint.exclusions.map((entry) => entry.scope),
            ...checkpoint.closedScopes,
        ]);
        return scopes.size === 1 ? [...scopes][0] : null;
    }, [guard]);
    const [revision, setRevision] = useState(0);
    const committed = useRef<{
        track: Track | null;
        queueGeneration: number;
        scope: string | null;
    } | null>(null);
    const persist = useCallback(() => {
        if (!isCurrent() || typeof window === "undefined") return;
        try {
            const checkpoint = guard.toCheckpoint();
            if (
                !checkpoint.allClosed &&
                checkpoint.exclusions.length === 0 &&
                checkpoint.closedScopes.length === 0
            )
                localStorage.removeItem(storageKey);
            else localStorage.setItem(storageKey, JSON.stringify(checkpoint));
        } catch {
            log.warn("Recommendation checkpoint could not be saved");
        }
    }, [guard, isCurrent]);
    const changed = useCallback(() => {
        // Retire denied speculative leases before React can advance or rerender.
        notifyRecommendationFeedbackChange();
        // Persist the guard before the layout pass removes future occurrences.
        persist();
        setRevision((value) => value + 1);
    }, [persist]);

    useLayoutEffect(() => {
        const before = { queue, currentIndex, isShuffle, shuffleIndices };
        const queueGeneration = getQueueReplacementGeneration();
        const previous = committed.current;
        const futureScope = uniqueFutureScope(before);
        committed.current = {
            track: currentTrack,
            queueGeneration,
            scope:
                (currentTrack
                    ? recommendationScopeForTrack(currentTrack)
                    : null) ??
                (previous?.queueGeneration === queueGeneration
                    ? previous.scope
                    : null) ??
                (futureScope === undefined && previous === null
                    ? restoredScope
                    : (futureScope ?? null)),
        };
        if (!isCurrent() || isCollaborative()) return;
        const after = guard.pruneFuture(before);
        persist();
        if (after !== before) publish(after);
    }, [
        guard,
        queue,
        currentIndex,
        isShuffle,
        shuffleIndices,
        currentTrack,
        publish,
        revision,
        isCurrent,
        isCollaborative,
        persist,
        restoredScope,
    ]);

    useLayoutEffect(() => {
        const pins = new WeakMap<RecommendationFeedbackIntent, number>();
        const admitted = () => {
            const view = committed.current;
            return (
                isCurrent() &&
                !isCollaborative() &&
                view !== null &&
                view.queueGeneration === getQueueReplacementGeneration() &&
                !isPlaybackFailureSupersededByManualIntent(
                    view.track?.id ?? null,
                )
            );
        };
        return registerRecommendationFeedbackOwner({
            begin: (trackId, signal) => {
                if (!admitted()) return null;
                const view = committed.current!;
                const scope = view.track ? view.scope : null;
                const before = guard.revision;
                const intent = guard.begin({ trackId, signal, scope });
                if (intent) pins.set(intent, view.queueGeneration);
                if (guard.revision !== before) changed();
                return intent;
            },
            reconcile: (intent, signal) => {
                const view = committed.current;
                if (
                    !admitted() ||
                    pins.get(intent) !== getQueueReplacementGeneration() ||
                    !view?.track ||
                    view.scope !== intent.scope
                )
                    return false;
                const before = guard.revision;
                const accepted = guard.reconcile(intent, signal);
                pins.delete(intent);
                if (guard.revision !== before) changed();
                return accepted;
            },
            reportFailure: () =>
                log.warn(
                    "Recommendation feedback could not update the current queue",
                ),
        });
    }, [guard, changed, isCurrent, isCollaborative]);

    const allows = useCallback(
        (track: QueueItem) =>
            isCurrent() && (isCollaborative() || guard.allows(track)),
        [guard, isCurrent, isCollaborative],
    );
    const reset = useCallback(() => {
        if (!isCurrent()) return;
        guard.reset();
        if (committed.current) committed.current.scope = null;
        changed();
    }, [guard, isCurrent, changed]);
    const pruneFuture = useCallback(
        (queue: RecommendationFeedbackQueue) =>
            isCurrent() && !isCollaborative()
                ? guard.pruneFuture(queue)
                : queue,
        [guard, isCurrent, isCollaborative],
    );
    return useMemo(
        () => ({ allows, reset, pruneFuture, revision }),
        [allows, reset, pruneFuture, revision],
    );
}
