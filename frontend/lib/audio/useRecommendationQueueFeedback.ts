"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Track } from "@/lib/audio-state-context";
import { api } from "@/lib/api";
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
import {
    RecommendationQueueAdmissionPolicy,
    type RecommendationQueuePreparation,
} from "./recommendationQueueAdmissionPolicy";
import type { RecommendationQueueAdmissionCapture } from "./recommendationQueueAdmission";

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
    /** Affirmative policy for speculative and automatic playback; manual rows bypass it. */
    readyFor?: (track: QueueItem) => boolean;
    prepareTrack?: (track: QueueItem) => Promise<boolean>;
    prepareTracks?: (
        tracks: readonly QueueItem[],
    ) => Promise<RecommendationQueuePreparation>;
    prepareAdvance?: (options: {
        includeCurrent?: boolean;
        wrap?: boolean;
        signal?: AbortSignal;
    }) => Promise<RecommendationQueuePreparation>;
    isAdvancePrepared?: (options: {
        includeCurrent?: boolean;
        wrap?: boolean;
    }) => boolean;
    captureAdmission?: () => RecommendationQueueAdmissionCapture;
    isAdmissionCurrent?: (
        capture: RecommendationQueueAdmissionCapture,
    ) => boolean;
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

function preparationItems(
    input: RecommendationFeedbackQueue,
    includeCurrent = false,
    wrap = false,
): QueueItem[] | null {
    if (input.currentIndex < 0 || input.currentIndex >= input.queue.length)
        return null;
    const order = input.isShuffle
        ? input.shuffleIndices
        : input.queue.map((_, index) => index);
    const position = order.indexOf(input.currentIndex);
    if (position < 0) return null;
    const indices = [
        ...(includeCurrent ? [input.currentIndex] : []),
        ...order.slice(position + 1),
        ...(wrap ? order.slice(0, position + 1) : []),
    ];
    return [...new Set(indices)].flatMap((index) =>
        input.queue[index] ? [input.queue[index]] : [],
    );
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
        view: RecommendationFeedbackQueue;
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
    const mounted = useRef(false);
    const hasFeedback = useRef(false);
    const [admissionOwner] = useState(() => Object.freeze({}));
    const [admission] = useState(
        () =>
            new RecommendationQueueAdmissionPolicy(
                (references, signal) =>
                    api.readmitRecommendationQueue(references, signal),
                admissionOwner,
            ),
    );
    useLayoutEffect(
        () =>
            admission.observeChanges(() => {
                if (mounted.current && isCurrent()) changed();
            }),
        [admission, changed, isCurrent],
    );
    const refreshFuture = useRef<() => Promise<RecommendationQueuePreparation>>(
        () => Promise.resolve("superseded"),
    );
    const prepare = useCallback(
        async (
            items: readonly QueueItem[],
            options: {
                refreshUnavailable?: boolean;
                untilAllowed?: boolean;
                signal?: AbortSignal;
            } = {},
        ): Promise<RecommendationQueuePreparation> => {
            if (!isCurrent()) return "superseded";
            if (isCollaborative()) return "ready";
            const generation = getQueueReplacementGeneration();
            const result = await admission.prepare(
                items.filter((item) => guard.allows(item)),
                options,
            );
            return isCurrent() &&
                !isCollaborative() &&
                generation === getQueueReplacementGeneration()
                ? result
                : "superseded";
        },
        [admission, guard, isCurrent, isCollaborative],
    );
    useLayoutEffect(() => {
        refreshFuture.current = async () => {
            const view = committed.current;
            if (
                !view ||
                view.queueGeneration !== getQueueReplacementGeneration()
            )
                return "superseded";
            const items = preparationItems(view.view);
            return items ? prepare(items) : "superseded";
        };
    }, [prepare]);

    useLayoutEffect(() => {
        const before = { queue, currentIndex, isShuffle, shuffleIndices };
        const queueGeneration = getQueueReplacementGeneration();
        const previous = committed.current;
        if (previous && previous.queueGeneration !== queueGeneration) {
            admission.replaceQueue();
        }
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
            view: before,
        };
        if (!isCurrent() || isCollaborative()) return;
        const after = guard.pruneFuture(before, (item) =>
            admission.allows(item),
        );
        persist();
        if (after !== before) publish(after);
        if (hasFeedback.current) {
            queueMicrotask(() => {
                if (mounted.current && isCurrent() && !isCollaborative())
                    void refreshFuture.current();
            });
        }
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
        admission,
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
        mounted.current = true;
        admission.setOwner(isCurrent() ? admissionOwner : null);
        const unregister = registerRecommendationFeedbackOwner({
            beginMutation: () => {
                if (!isCurrent() || isCollaborative()) return null;
                hasFeedback.current = true;
                return admission.beginMutation();
            },
            settleMutation: (token) => {
                admission.settleMutation(token);
                queueMicrotask(() => {
                    if (mounted.current && isCurrent() && !isCollaborative())
                        void refreshFuture.current();
                });
            },
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
        return () => {
            mounted.current = false;
            unregister();
            admission.setOwner(null);
        };
    }, [guard, changed, isCurrent, isCollaborative, admission, admissionOwner]);

    const allows = useCallback(
        (track: QueueItem) =>
            isCurrent() &&
            (isCollaborative() ||
                (guard.allows(track) && admission.allows(track))),
        [guard, admission, isCurrent, isCollaborative],
    );
    const reset = useCallback(() => {
        if (!isCurrent()) return;
        guard.reset();
        if (committed.current) committed.current.scope = null;
        hasFeedback.current = false;
        admission.replaceQueue();
    }, [guard, admission, isCurrent]);
    const pruneFuture = useCallback(
        (queue: RecommendationFeedbackQueue) =>
            isCurrent() && !isCollaborative()
                ? guard.pruneFuture(queue, (item) => admission.allows(item))
                : queue,
        [guard, admission, isCurrent, isCollaborative],
    );
    const readyFor = useCallback(
        (track: QueueItem) =>
            isCurrent() &&
            (isCollaborative() ||
                (committed.current?.queueGeneration ===
                    getQueueReplacementGeneration() &&
                    guard.allows(track) &&
                    admission.readyFor(track))),
        [admission, guard, isCurrent, isCollaborative],
    );
    const prepareTrack = useCallback(
        async (track: QueueItem) => {
            const view = committed.current;
            const upcoming =
                !isEpisodeQueueItem(track) &&
                recommendationScopeForTrack(track) &&
                view
                    ? (preparationItems(view.view)?.slice(0, 5) ?? [])
                    : [];
            const items = [...new Set([track, ...upcoming])];
            return (await prepare(items)) === "ready" && readyFor(track);
        },
        [prepare, readyFor],
    );
    const prepareTracks = useCallback(
        (tracks: readonly QueueItem[]) => prepare(tracks),
        [prepare],
    );
    const prepareAdvance = useCallback(
        async (
            options: {
                includeCurrent?: boolean;
                wrap?: boolean;
                signal?: AbortSignal;
            } = {},
        ) => {
            const view = committed.current;
            if (
                !view ||
                view.queueGeneration !== getQueueReplacementGeneration()
            )
                return "superseded" as const;
            const items = preparationItems(
                view.view,
                options.includeCurrent,
                options.wrap,
            );
            return items
                ? prepare(items, {
                      refreshUnavailable: true,
                      untilAllowed: true,
                      signal: options.signal,
                  })
                : ("superseded" as const);
        },
        [prepare],
    );
    const isAdvancePrepared = useCallback(
        (options: { includeCurrent?: boolean; wrap?: boolean } = {}) => {
            if (!isCurrent()) return false;
            if (isCollaborative()) return true;
            const view = committed.current;
            if (
                !view ||
                view.queueGeneration !== getQueueReplacementGeneration()
            )
                return false;
            const items = preparationItems(
                view.view,
                options.includeCurrent,
                options.wrap,
            );
            if (!items) return false;
            const candidate = items.find(
                (item) => guard.allows(item) && admission.allows(item),
            );
            return !candidate || admission.readyFor(candidate);
        },
        [admission, guard, isCurrent, isCollaborative],
    );
    const captureAdmission = useCallback(
        () => admission.coordinator.capture(),
        [admission],
    );
    const isAdmissionCurrent = useCallback(
        (capture: RecommendationQueueAdmissionCapture) =>
            isCurrent() &&
            !isCollaborative() &&
            committed.current?.queueGeneration ===
                getQueueReplacementGeneration() &&
            admission.coordinator.isCurrent(capture),
        [admission, isCurrent, isCollaborative],
    );
    return useMemo(
        () => ({
            allows,
            reset,
            pruneFuture,
            revision,
            readyFor,
            prepareTrack,
            prepareTracks,
            prepareAdvance,
            isAdvancePrepared,
            captureAdmission,
            isAdmissionCurrent,
        }),
        [
            allows,
            reset,
            pruneFuture,
            revision,
            readyFor,
            prepareTrack,
            prepareTracks,
            prepareAdvance,
            isAdvancePrepared,
            captureAdmission,
            isAdmissionCurrent,
        ],
    );
}
