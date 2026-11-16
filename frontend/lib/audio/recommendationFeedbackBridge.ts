"use client";

import type { TrackPreferenceSignal } from "@/lib/api";
import type { RecommendationFeedbackIntent } from "./recommendationQueueFeedback";

/** The mounted queue authority supplies its own owner/lineage admission checks. */
export interface RecommendationFeedbackOwner {
    begin: (
        trackId: string,
        signal: TrackPreferenceSignal,
    ) => RecommendationFeedbackIntent | null;
    reconcile: (
        intent: RecommendationFeedbackIntent,
        signal: TrackPreferenceSignal,
    ) => boolean;
    reportFailure: () => void;
}

interface Registration {
    owner: RecommendationFeedbackOwner;
}

/** Ephemeral receipt; never serialize it or transfer it to another queue owner. */
export interface CapturedRecommendationFeedback {
    readonly registration: object;
    readonly intent: RecommendationFeedbackIntent;
}

// Registration happens in the authenticated provider's client effect only.
// No preference/request state is installed during server rendering.
let current: Registration | null = null;
const changeListeners = new Set<() => void>();

/** Subscribe only while a mounted player owns speculative audio resources. */
export function subscribeRecommendationFeedbackChanges(
    listener: () => void,
): () => void {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
}

/** Recheck speculative work synchronously; no owner or recording data is sent. */
export function notifyRecommendationFeedbackChange(): void {
    for (const listener of changeListeners) {
        try {
            listener();
        } catch {
            current?.owner.reportFailure();
        }
    }
}

/** A stale cleanup cannot unregister a newer mounted queue. */
export function registerRecommendationFeedbackOwner(
    owner: RecommendationFeedbackOwner,
): () => void {
    const registration = { owner };
    current = registration;
    return () => {
        if (current === registration) current = null;
    };
}

/** Capture synchronously before the preference request or optimistic cache await. */
export function captureRecommendationFeedback(
    trackId: string,
    signal: TrackPreferenceSignal,
): CapturedRecommendationFeedback | null {
    const registration = current;
    if (!registration) return null;
    try {
        const intent = registration.owner.begin(trackId, signal);
        return intent && current === registration
            ? Object.freeze({ registration, intent })
            : null;
    } catch {
        registration.owner.reportFailure();
        return null;
    }
}

/** A delayed ACK or rollback affects only the queue which captured that intent. */
export function reconcileRecommendationFeedback(
    receipt: CapturedRecommendationFeedback | null,
    signal: TrackPreferenceSignal,
): boolean {
    const registration = current;
    if (!receipt || registration !== receipt.registration) return false;
    try {
        return registration.owner.reconcile(receipt.intent, signal);
    } catch {
        registration.owner.reportFailure();
        return false;
    }
}
