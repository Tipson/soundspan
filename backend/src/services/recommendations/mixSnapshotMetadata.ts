/** Bounded explanations for unavailable or incomplete finite mixes; never raw provider errors. */
export type MixSnapshotReason =
    | "provider_degraded"
    | "pool_limited"
    | "feedback_filtered";

/** Additive finite-mix metadata. A read, repaint or feedback filter never renews its generation time. */
export interface MixSnapshotMetadata {
    /** Real composition/generation time, absent when no snapshot or legacy time is known. */
    generatedAt?: string;
    /** Daily composition's UTC calendar day; independent of the client's local midnight. */
    compositionDay?: string;
    /** Weekly composition's inclusive UTC start. */
    weekStart?: string;
    /** Weekly composition's inclusive UTC end. */
    weekEnd?: string;
    /** Earliest existing cache/day/week boundary at which this result should be refreshed. */
    refreshAfter: string;
    /** Desired track count; never a promise that enough eligible tracks exist. */
    requestedCount: number;
    /** Track count of the original playable snapshot, zero when none was formed. */
    snapshotCount: number;
    /** Currently returned playable count after fresh feedback and availability admission. */
    availableCount: number;
    /** Observed reasons only; provider failures are not evidence of negative musical taste. */
    reasons: MixSnapshotReason[];
}
