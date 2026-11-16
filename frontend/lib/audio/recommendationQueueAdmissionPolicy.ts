import {
    RecommendationQueueAdmission,
    RECOMMENDATION_QUEUE_ADMISSION_TIMEOUT_MS,
    snapshotQueueAdmissionReferences,
    type FiniteQueueAdmissionReference,
    type RecommendationQueueAdmissionCapture,
    type RecommendationQueueAdmissionOwner,
    type RecommendationQueueAdmissionResult,
    type RecommendationQueuePreferenceMutation,
} from "./recommendationQueueAdmission";
import { recommendationScopeForTrack } from "./recommendationQueueFeedback";
import { isEpisodeQueueItem, type QueueItem } from "../queue-item";
import { resolvePreferenceTrackId } from "../trackRef";

/** Resolve exact backing only; server generation context never grants identity authority. */
export function recommendationAdmissionReference(
    item: QueueItem,
): FiniteQueueAdmissionReference | null {
    if (!item || isEpisodeQueueItem(item)) return null;
    const id = resolvePreferenceTrackId(item);
    let reference: FiniteQueueAdmissionReference;
    if (id.startsWith("yt:"))
        reference = { source: "youtube", id: id.slice(3) };
    else if (id.startsWith("tidal:"))
        reference = { source: "tidal", id: id.slice(6) };
    else if (id.startsWith("vk:"))
        reference = { source: "vk", id: id.slice(3) };
    else if (id.startsWith("yandex:"))
        reference = { source: "yandex", id: id.slice(7) };
    else reference = { source: "library", id };
    if (item.recommendationGenerationId !== undefined)
        reference = {
            ...reference,
            generationId: item.recommendationGenerationId,
        };
    return snapshotQueueAdmissionReferences([reference])?.[0] ?? null;
}

interface Entry {
    manual: boolean;
    key: string | null;
    reference: FiniteQueueAdmissionReference | null;
}
interface Decision {
    capture: RecommendationQueueAdmissionCapture;
    state: "allowed" | "denied" | "unavailable";
}
/** Completion of a bounded check; individual recommendations still require readyFor(). */
export type RecommendationQueuePreparation =
    | "ready"
    | "unavailable"
    | "superseded";
interface PrepareOptions {
    signal?: AbortSignal;
    refreshUnavailable?: boolean;
    untilAllowed?: boolean;
}

function entryFor(item: QueueItem): Entry {
    if (!item) return { manual: false, key: null, reference: null };
    if (isEpisodeQueueItem(item))
        return { manual: true, key: null, reference: null };
    const scope = recommendationScopeForTrack(item);
    if (!scope) return { manual: true, key: null, reference: null };
    const reference = recommendationAdmissionReference(item);
    return {
        manual: false,
        reference,
        key: reference ? JSON.stringify([scope, reference]) : null,
    };
}

/** Ephemeral owner/occurrence policy cache; no queue edits or durable preferences. */
export class RecommendationQueueAdmissionPolicy {
    readonly coordinator: RecommendationQueueAdmission;
    private readonly decisions = new Map<string, Decision>();
    private readonly preparing = new Map<
        string,
        Promise<RecommendationQueuePreparation>
    >();
    private legacyCapture: RecommendationQueueAdmissionCapture | null = null;
    private static readonly maxCachedDecisions = 2000;

    constructor(
        request: (
            refs: readonly FiniteQueueAdmissionReference[],
            signal: AbortSignal,
        ) => Promise<RecommendationQueueAdmissionResult>,
        owner: RecommendationQueueAdmissionOwner | null,
        private changed: () => void = () => {},
    ) {
        this.coordinator = new RecommendationQueueAdmission(request, owner);
    }

    /** Install the mounted owner's callback after render and retire only that callback. */
    observeChanges(listener: () => void): () => void {
        const previous = this.changed;
        this.changed = listener;
        return () => {
            if (this.changed === listener) this.changed = previous;
        };
    }

    /** Every actual preference begin invalidates speculative permission synchronously. */
    beginMutation(): RecommendationQueuePreferenceMutation {
        const token = this.coordinator.beginPreferenceMutation();
        this.clear();
        return token;
    }
    settleMutation(token: RecommendationQueuePreferenceMutation): void {
        this.coordinator.settlePreferenceMutation(token);
    }
    setOwner(owner: RecommendationQueueAdmissionOwner | null): void {
        if (owner === this.coordinator.capture().owner) return;
        this.coordinator.setOwner(owner);
        this.clear();
    }
    replaceQueue(): void {
        this.coordinator.replaceQueue();
        this.clear();
    }
    private clear(): void {
        this.decisions.clear();
        this.preparing.clear();
        this.legacyCapture = null;
        this.changed();
    }
    private read(entry: Entry): Decision["state"] | undefined {
        const decision = entry.key ? this.decisions.get(entry.key) : undefined;
        return decision && this.coordinator.isCurrent(decision.capture)
            ? decision.state
            : undefined;
    }
    private legacy(): boolean {
        return (
            this.legacyCapture !== null &&
            this.coordinator.isCurrent(this.legacyCapture)
        );
    }
    /** Unknown/unavailable evidence cannot turn into a persisted dislike. */
    allows(item: QueueItem): boolean {
        const entry = entryFor(item);
        return entry.manual || this.read(entry) !== "denied";
    }
    /** Automatic preparation and transition require an affirmative current decision. */
    readyFor(item: QueueItem): boolean {
        const entry = entryFor(item);
        if (entry.manual) return true;
        const state = this.read(entry);
        if (state === "denied") return false;
        return state === "allowed" || this.legacy();
    }

    /** Check finite ordered windows, with one shared deadline across every <=100 batch. */
    prepare(
        items: readonly QueueItem[],
        options: PrepareOptions = {},
    ): Promise<RecommendationQueuePreparation> {
        const capture = this.coordinator.capture();
        if (!this.coordinator.isCurrent(capture))
            return Promise.resolve("superseded");
        const entries = items.map(entryFor);
        const key = JSON.stringify([
            entries.map((entry) => (entry.manual ? "manual" : entry.key)),
            Boolean(options.refreshUnavailable),
            Boolean(options.untilAllowed),
        ]);
        if (!options.signal) {
            const existing = this.preparing.get(key);
            if (existing) return existing;
        }
        const pending = this.run(entries, capture, options);
        if (!options.signal) {
            this.preparing.set(key, pending);
            void pending.finally(() => {
                if (this.preparing.get(key) === pending)
                    this.preparing.delete(key);
            });
        }
        return pending;
    }

    private async run(
        entries: readonly Entry[],
        capture: RecommendationQueueAdmissionCapture,
        options: PrepareOptions,
    ): Promise<RecommendationQueuePreparation> {
        const controller = new AbortController();
        const signal = options.signal
            ? AbortSignal.any([options.signal, controller.signal])
            : controller.signal;
        const timer = setTimeout(
            () => controller.abort(),
            RECOMMENDATION_QUEUE_ADMISSION_TIMEOUT_MS,
        );
        let unavailable = false;
        let allowed = false;
        let batch: Entry[] = [];
        const current = () => this.coordinator.isCurrent(capture);
        const flush = async (): Promise<RecommendationQueuePreparation> => {
            if (!batch.length) return "ready";
            const requested = batch;
            batch = [];
            const result = await this.coordinator.readmit(
                requested.map((entry) => entry.reference!),
                signal,
            );
            if (!current() || result.status === "superseded")
                return "superseded";
            if (signal.aborted || result.status === "unavailable") {
                // Progress ticks must not turn a failed speculative read into
                // a request loop. Explicit advance may retry this transient
                // state; caller cancellation is not a transport failure.
                if (!options.signal?.aborted) {
                    for (const entry of requested) {
                        if (
                            !this.decisions.has(entry.key!) &&
                            this.decisions.size >=
                                RecommendationQueueAdmissionPolicy.maxCachedDecisions
                        )
                            this.decisions.delete(
                                this.decisions.keys().next().value!,
                            );
                        this.decisions.set(entry.key!, {
                            capture,
                            state: "unavailable",
                        });
                    }
                    this.changed();
                }
                return "unavailable";
            }
            if (result.status === "legacy_exact") {
                this.legacyCapture = capture;
                allowed = true;
                this.changed();
                return "ready";
            }
            if (result.status !== "ready") return "unavailable";
            let changed = false;
            for (let index = 0; index < requested.length; index++) {
                const entry = requested[index];
                const state = result.response.decisions[index].state;
                const previous = this.read(entry);
                if (previous !== state) changed = true;
                if (
                    !this.decisions.has(entry.key!) &&
                    this.decisions.size >=
                        RecommendationQueueAdmissionPolicy.maxCachedDecisions
                )
                    this.decisions.delete(this.decisions.keys().next().value!);
                this.decisions.set(entry.key!, { capture, state });
                if (state === "allowed") allowed = true;
                if (state === "unavailable") unavailable = true;
            }
            if (changed) this.changed();
            return current() ? "ready" : "superseded";
        };
        try {
            for (const entry of entries) {
                if (!current()) return "superseded";
                if (signal.aborted) return "unavailable";
                const state = this.read(entry);
                if (
                    entry.manual ||
                    state === "allowed" ||
                    (this.legacy() && state !== "denied")
                ) {
                    const result = await flush();
                    if (result !== "ready") return result;
                    allowed = true;
                    if (options.untilAllowed) return "ready";
                    continue;
                }
                if (!entry.reference || !entry.key) {
                    unavailable = true;
                    continue;
                }
                if (state === "denied") continue;
                if (state === "unavailable" && !options.refreshUnavailable) {
                    unavailable = true;
                    continue;
                }
                batch.push(entry);
                if (batch.length === 100) {
                    const result = await flush();
                    if (result !== "ready") return result;
                    if (options.untilAllowed && allowed) return "ready";
                }
            }
            const result = await flush();
            if (result !== "ready") return result;
            return unavailable && !allowed ? "unavailable" : "ready";
        } finally {
            clearTimeout(timer);
            controller.abort();
        }
    }
}
