import type { TrackPreferenceSignal } from "@/lib/api";
import type { Track } from "@/lib/audio-state-context";
import { isEpisodeQueueItem, type QueueItem } from "@/lib/queue-item";
import { resolvePreferenceTrackId } from "@/lib/trackRef";

/** Original feedback intent; only its owning queue can reconcile this object. */
export interface RecommendationFeedbackIntent {
    readonly scope: string;
    readonly trackId: string;
}

/** Queue ordering metadata; transport position and playback intent are untouched. */
export interface RecommendationFeedbackQueue {
    queue: QueueItem[];
    currentIndex: number;
    isShuffle: boolean;
    shuffleIndices: number[];
}

/** Versioned nonsecret owner checkpoint, separate from the legacy queue JSON. */
export interface RecommendationFeedbackCheckpoint {
    version: 1;
    exclusions: { scope: string; trackIds: string[] }[];
    closedScopes: string[];
    allClosed: boolean;
}

function validText(value: unknown, max: number): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= max &&
        !/[\x00-\x1f]/.test(value)
    );
}

function validScope(value: unknown): value is string {
    return validText(value, 160) && /^(session|generation):.+$/.test(value);
}

function validTrackId(value: unknown): value is string {
    return validText(value, 512) && !value.includes("://");
}

/** Admit an exact-recording ACK, retaining legacy servers without policy fields.
 * Unknown policy versions/scopes cannot clear or expand a captured exclusion.
 */
export function resolveRecommendationFeedbackAck(
    trackId: string,
    value: unknown,
): TrackPreferenceSignal | null {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const response = value as Record<string, unknown>;
    const signal = response.signal;
    if (
        response.trackId !== trackId ||
        (signal !== "thumbs_up" &&
            signal !== "thumbs_down" &&
            signal !== "clear")
    )
        return null;
    if (response.queuePolicy === undefined) return signal;
    const policy = response.queuePolicy;
    if (!policy || typeof policy !== "object" || Array.isArray(policy))
        return null;
    const applied = policy as Record<string, unknown>;
    return applied.version === 1 &&
        applied.scope === "exact_recording" &&
        applied.appliesTo === "recommended_future" &&
        applied.trackId === trackId &&
        applied.effect === (signal === "thumbs_down" ? "exclude" : "allow")
        ? signal
        : null;
}

/** Session lineage spans pages; a generation alone supports legacy snapshots. */
export function recommendationScopeForTrack(track: Track): string | null {
    for (const [prefix, value] of [
        ["session", track.recommendationSessionId],
        ["generation", track.recommendationGenerationId],
    ] as const) {
        if (value == null) continue;
        if (!validText(value, 128) || !value.trim()) return null;
        return `${prefix}:${value.trim()}`;
    }
    return null;
}

/** Synchronous owner-local exact feedback, independent of React/network timing.
 * Reset at explicit queue/owner replacement. Late receipts never acquire a new
 * queue, and clearing a guard cannot reconstruct already removed occurrences.
 */
export class RecommendationQueueFeedback {
    private readonly exclusions = new Map<string, Set<string>>();
    private readonly closedScopes = new Set<string>();
    private readonly pending = new Map<string, RecommendationFeedbackIntent>();
    private excludedCount = 0;
    private closed = false;
    private changeRevision = 0;
    static readonly maxEntries = 2000;
    static readonly maxCheckpointBytes = 1024 * 1024;

    /** Changes only on feedback/reset, never on playback-clock ticks. */
    get revision(): number {
        return this.changeRevision;
    }

    /** Reserve synchronously before an asynchronous preference mutation. */
    begin(input: {
        trackId: string;
        scope: string | null;
        signal: TrackPreferenceSignal;
    }): RecommendationFeedbackIntent | null {
        if (!validScope(input.scope) || !validTrackId(input.trackId))
            return null;
        const key = `${input.scope}\u0000${input.trackId}`;
        if (
            !this.pending.has(key) &&
            this.pending.size >= RecommendationQueueFeedback.maxEntries
        ) {
            this.closeScope(input.scope);
            return null;
        }
        const intent = Object.freeze({
            scope: input.scope,
            trackId: input.trackId,
        });
        this.pending.set(key, intent);
        this.apply(intent, input.signal);
        return intent;
    }

    /** Reconcile the latest visible preference, even if an older ACK arrived. */
    reconcile(
        intent: RecommendationFeedbackIntent,
        signal: TrackPreferenceSignal,
    ): boolean {
        const key = `${intent.scope}\u0000${intent.trackId}`;
        if (this.pending.get(key) !== intent) return false;
        this.apply(intent, signal);
        this.pending.delete(key);
        return true;
    }

    private closeScope(scope: string): void {
        if (this.closed || this.closedScopes.has(scope)) return;
        if (this.closedScopes.size >= RecommendationQueueFeedback.maxEntries)
            this.closed = true;
        else this.closedScopes.add(scope);
        this.changeRevision++;
    }

    private apply(
        intent: RecommendationFeedbackIntent,
        signal: TrackPreferenceSignal,
    ): void {
        const refs = this.exclusions.get(intent.scope);
        if (signal !== "thumbs_down") {
            if (refs?.delete(intent.trackId)) {
                this.excludedCount--;
                this.changeRevision++;
                if (refs.size === 0) this.exclusions.delete(intent.scope);
            }
            return;
        }
        if (refs?.has(intent.trackId)) return;
        if (this.excludedCount >= RecommendationQueueFeedback.maxEntries) {
            this.closeScope(intent.scope);
            return;
        }
        const target = refs ?? new Set<string>();
        target.add(intent.trackId);
        this.exclusions.set(intent.scope, target);
        this.excludedCount++;
        this.changeRevision++;
    }

    /** Manual tracks and episodes are outside recommendation feedback scope. */
    allows(track: QueueItem): boolean {
        if (isEpisodeQueueItem(track)) return true;
        const scope = recommendationScopeForTrack(track);
        return (
            scope === null ||
            (!this.closed &&
                !this.closedScopes.has(scope) &&
                !this.exclusions
                    .get(scope)
                    ?.has(resolvePreferenceTrackId(track)))
        );
    }

    /** Preserve history/current and remap shuffle positions after future pruning. */
    pruneFuture(
        input: RecommendationFeedbackQueue,
        admitsAdditional: (track: QueueItem) => boolean = () => true,
    ): RecommendationFeedbackQueue {
        if (input.currentIndex < 0 || input.currentIndex >= input.queue.length)
            return input;
        const shufflePosition = input.isShuffle
            ? input.shuffleIndices.indexOf(input.currentIndex)
            : -1;
        if (input.isShuffle && shufflePosition < 0) return input;
        const upcoming =
            shufflePosition < 0
                ? null
                : new Set(input.shuffleIndices.slice(shufflePosition + 1));
        const oldToNew = new Map<number, number>();
        const queue = input.queue.filter((track, index) => {
            if (
                (upcoming?.has(index) ?? index > input.currentIndex) &&
                (!this.allows(track) || !admitsAdditional(track))
            )
                return false;
            oldToNew.set(index, oldToNew.size);
            return true;
        });
        if (queue.length === input.queue.length) return input;
        return {
            ...input,
            queue,
            currentIndex: oldToNew.get(input.currentIndex)!,
            shuffleIndices: input.shuffleIndices.flatMap((index) => {
                const next = oldToNew.get(index);
                return next === undefined ? [] : [next];
            }),
        };
    }

    /** Retire outstanding receipts as well as masks on owner/explicit reset. */
    reset(): void {
        this.pending.clear();
        this.exclusions.clear();
        this.closedScopes.clear();
        this.excludedCount = 0;
        this.closed = false;
        this.changeRevision++;
    }

    /** Capture only portable masks; pending receipt objects never survive boot. */
    toCheckpoint(): RecommendationFeedbackCheckpoint {
        const row: RecommendationFeedbackCheckpoint = {
            version: 1,
            exclusions: [...this.exclusions].map(([scope, ids]) => ({
                scope,
                trackIds: [...ids].sort(),
            })),
            closedScopes: [...this.closedScopes].sort(),
            allClosed: this.closed,
        };
        if (
            new TextEncoder().encode(JSON.stringify(row)).length >
            RecommendationQueueFeedback.maxCheckpointBytes
        ) {
            throw new TypeError("Recommendation checkpoint exceeds its bound");
        }
        return row;
    }

    /** Unknown/corrupt state fails closed for recommendations, keeping manual music usable. */
    static fromCheckpoint(value: unknown): RecommendationQueueFeedback {
        const guard = new RecommendationQueueFeedback();
        if (value == null) return guard;
        try {
            if (typeof value !== "object" || Array.isArray(value))
                throw new TypeError();
            const row = value as Record<string, unknown>;
            const keys = ["version", "exclusions", "closedScopes", "allClosed"];
            if (
                Object.keys(row).length !== keys.length ||
                Object.keys(row).some((key) => !keys.includes(key)) ||
                row.version !== 1 ||
                typeof row.allClosed !== "boolean"
            )
                throw new TypeError();
            if (
                !Array.isArray(row.exclusions) ||
                row.exclusions.length > this.maxEntries ||
                !Array.isArray(row.closedScopes) ||
                row.closedScopes.length > this.maxEntries ||
                !row.closedScopes.every(validScope)
            )
                throw new TypeError();
            const seenScopes = new Set<string>();
            for (const entry of row.exclusions) {
                if (
                    typeof entry !== "object" ||
                    entry === null ||
                    Array.isArray(entry)
                )
                    throw new TypeError();
                const item = entry as Record<string, unknown>;
                if (
                    Object.keys(item).length !== 2 ||
                    !validScope(item.scope) ||
                    seenScopes.has(item.scope) ||
                    !Array.isArray(item.trackIds)
                )
                    throw new TypeError();
                seenScopes.add(item.scope);
                if (
                    guard.excludedCount + item.trackIds.length >
                        this.maxEntries ||
                    !item.trackIds.every(validTrackId)
                )
                    throw new TypeError();
                const refs = new Set<string>(item.trackIds);
                if (refs.size !== item.trackIds.length) throw new TypeError();
                if (refs.size > 0) guard.exclusions.set(item.scope, refs);
                guard.excludedCount += refs.size;
            }
            if (
                new TextEncoder().encode(JSON.stringify(value)).length >
                this.maxCheckpointBytes
            )
                throw new TypeError();
            guard.closed = row.allClosed;
            for (const scope of row.closedScopes) guard.closedScopes.add(scope);
        } catch {
            guard.exclusions.clear();
            guard.excludedCount = 0;
            guard.closedScopes.clear();
            guard.closed = true;
        }
        return guard;
    }
}
