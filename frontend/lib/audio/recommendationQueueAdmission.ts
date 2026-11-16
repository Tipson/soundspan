/** Stable recording references only; client artist/canonical metadata is never evidence. */
export interface FiniteQueueAdmissionReference {
    readonly source: "library" | "youtube" | "tidal" | "vk" | "yandex";
    readonly id: string;
    readonly generationId?: string;
}

/** Ordered occurrence decisions affect future automatic recommendations only. */
export interface FiniteQueueAdmissionResponse {
    readonly version: 1;
    readonly appliesTo: "recommended_future";
    readonly decisions: readonly {
        readonly source: FiniteQueueAdmissionReference["source"];
        readonly id: string;
        readonly state: "allowed" | "denied" | "unavailable";
    }[];
}

/** Legacy exact compatibility is explicit; unavailable never grants permission. */
export type RecommendationQueueAdmissionResult =
    | {
          readonly status: "ready";
          readonly response: FiniteQueueAdmissionResponse;
      }
    | { readonly status: "legacy_exact" | "unavailable" };

/** Total client budget, including pending preference writes and auth refresh. */
export const RECOMMENDATION_QUEUE_ADMISSION_TIMEOUT_MS = 17_000;

function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/** Validate the entire finite batch without truncating or deduplicating occurrences. */
export function snapshotQueueAdmissionReferences(
    values: readonly FiniteQueueAdmissionReference[],
): readonly FiniteQueueAdmissionReference[] | null {
    if (!Array.isArray(values) || values.length < 1 || values.length > 100)
        return null;
    const references: FiniteQueueAdmissionReference[] = [];
    for (const value of values) {
        const row = object(value);
        if (!row || typeof row.id !== "string") return null;
        const { source, id, generationId } = row;
        if (
            generationId !== undefined &&
            (typeof generationId !== "string" ||
                generationId.length < 1 ||
                generationId.length > 128)
        )
            return null;
        switch (source) {
            case "library":
                if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
                break;
            case "youtube":
                if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
                break;
            case "tidal":
                if (
                    !/^[1-9]\d{0,19}$/.test(id) ||
                    !Number.isSafeInteger(Number(id))
                )
                    return null;
                break;
            case "vk":
                if (!/^-?\d{1,20}_\d{1,20}$/.test(id)) return null;
                break;
            case "yandex":
                if (!/^\d{1,20}$/.test(id) || !/[1-9]/.test(id)) return null;
                break;
            default:
                return null;
        }
        references.push(
            Object.freeze({
                source,
                id,
                ...(generationId === undefined ? {} : { generationId }),
            }),
        );
    }
    return Object.freeze(references);
}

/** Parse only the frozen policy contract, matching source/id/order/cardinality exactly. */
export function parseQueueAdmissionResponse(
    value: unknown,
    references: readonly FiniteQueueAdmissionReference[],
): FiniteQueueAdmissionResponse | null {
    const row = object(value);
    if (
        !row ||
        row.version !== 1 ||
        row.appliesTo !== "recommended_future" ||
        !Array.isArray(row.decisions) ||
        row.decisions.length !== references.length
    )
        return null;
    const decisions: FiniteQueueAdmissionResponse["decisions"][number][] = [];
    for (let index = 0; index < references.length; index++) {
        const decision = object(row.decisions[index]);
        const reference = references[index];
        if (
            !decision ||
            decision.source !== reference.source ||
            decision.id !== reference.id ||
            (decision.state !== "allowed" &&
                decision.state !== "denied" &&
                decision.state !== "unavailable")
        )
            return null;
        decisions.push(
            Object.freeze({
                source: reference.source,
                id: reference.id,
                state: decision.state,
            }),
        );
    }
    return Object.freeze({
        version: 1,
        appliesTo: "recommended_future",
        decisions: Object.freeze(decisions),
    });
}

/** Opaque logical auth/storage owner session, not merely a persisted user id. */
export type RecommendationQueueAdmissionOwner = string | object;

/** Owner, explicit queue replacement and every local preference begin form one fence. */
export interface RecommendationQueueAdmissionCapture {
    readonly owner: RecommendationQueueAdmissionOwner | null;
    readonly mutationEpoch: number;
    readonly queueEpoch: number;
}

/** One token per write, including repeated writes and writes without an exclusion change. */
export interface RecommendationQueuePreferenceMutation {
    readonly mutationEpoch: number;
}

/** Recheck the capture immediately before applying a ready response to its queue. */
export type CapturedRecommendationQueueAdmissionResult = (
    | RecommendationQueueAdmissionResult
    | { readonly status: "superseded" }
) & { readonly capture: RecommendationQueueAdmissionCapture };

type AdmissionRequest = (
    references: readonly FiniteQueueAdmissionReference[],
    signal: AbortSignal,
) => Promise<RecommendationQueueAdmissionResult>;

interface PendingAdmission {
    readonly capture: RecommendationQueueAdmissionCapture;
    readonly references: readonly FiniteQueueAdmissionReference[];
    readonly controller: AbortController;
    readonly promise: Promise<CapturedRecommendationQueueAdmissionResult>;
    readonly finish: (
        result: RecommendationQueueAdmissionResult | { status: "superseded" },
    ) => void;
    started: boolean;
}

/** Owner-local finite coordination, with no playback, queue or durable preference mutations. */
export class RecommendationQueueAdmission {
    private current: RecommendationQueueAdmissionCapture;
    private readonly pendingWrites =
        new Set<RecommendationQueuePreferenceMutation>();
    private readonly requests = new Map<string | symbol, PendingAdmission>();

    constructor(
        private readonly request: AdmissionRequest,
        owner: RecommendationQueueAdmissionOwner | null,
    ) {
        this.current = Object.freeze({
            owner,
            mutationEpoch: 0,
            queueEpoch: 0,
        });
    }

    /** Capture before awaiting a recommendation page; compare again before attachment. */
    capture(): RecommendationQueueAdmissionCapture {
        return this.current;
    }

    /** Object identity prevents another coordinator or an old owner from acquiring this queue. */
    isCurrent(capture: RecommendationQueueAdmissionCapture): boolean {
        return this.current.owner !== null && capture === this.current;
    }

    /** Every begin advances ordering even if the exact exclusion mask stays unchanged. */
    beginPreferenceMutation(): RecommendationQueuePreferenceMutation {
        this.invalidate({
            ...this.current,
            mutationEpoch: this.current.mutationEpoch + 1,
        });
        const token = Object.freeze({
            mutationEpoch: this.current.mutationEpoch,
        });
        this.pendingWrites.add(token);
        return token;
    }

    /** Call in the preference write's finally, including failed or lost acknowledgements. */
    settlePreferenceMutation(
        token: RecommendationQueuePreferenceMutation,
    ): void {
        if (!this.pendingWrites.delete(token) || this.pendingWrites.size > 0)
            return;
        for (const entry of this.requests.values()) this.start(entry);
    }

    /** Session keys must change for login/storage replacement even when the user id is equal. */
    setOwner(owner: RecommendationQueueAdmissionOwner | null): void {
        if (owner === this.current.owner) return;
        this.pendingWrites.clear();
        this.invalidate({ owner, mutationEpoch: 0, queueEpoch: 0 });
    }

    /** Retire the old queue without forgetting same-owner preference writes still in flight. */
    replaceQueue(): void {
        this.invalidate({
            ...this.current,
            queueEpoch: this.current.queueEpoch + 1,
        });
    }

    private invalidate(capture: RecommendationQueueAdmissionCapture): void {
        this.current = Object.freeze(capture);
        for (const entry of this.requests.values())
            entry.finish({ status: "superseded" });
    }

    /** One bounded attempt; only identical refs in this capture without caller signals share work. */
    readmit(
        references: readonly FiniteQueueAdmissionReference[],
        signal?: AbortSignal,
    ): Promise<CapturedRecommendationQueueAdmissionResult> {
        const capture = this.current;
        const snapshot = snapshotQueueAdmissionReferences(references);
        if (capture.owner === null || signal?.aborted || !snapshot)
            return Promise.resolve({ status: "unavailable", capture });
        const key = signal ? Symbol() : JSON.stringify(snapshot);
        const existing = this.requests.get(key);
        if (existing) return existing.promise;
        let resolve!: (
            value: CapturedRecommendationQueueAdmissionResult,
        ) => void;
        const promise = new Promise<CapturedRecommendationQueueAdmissionResult>(
            (done) => {
                resolve = done;
            },
        );
        const controller = new AbortController();
        let finished = false;
        const onAbort = () => entry.finish({ status: "unavailable" });
        const entry: PendingAdmission = {
            capture,
            references: snapshot,
            controller,
            promise,
            started: false,
            finish: (result) => {
                if (finished) return;
                finished = true;
                this.requests.delete(key);
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                controller.abort();
                resolve({ ...result, capture });
            },
        };
        this.requests.set(key, entry);
        const timer = setTimeout(
            onAbort,
            RECOMMENDATION_QUEUE_ADMISSION_TIMEOUT_MS,
        );
        signal?.addEventListener("abort", onAbort, { once: true });
        if (this.pendingWrites.size === 0) this.start(entry);
        return promise;
    }

    private start(entry: PendingAdmission): void {
        if (entry.started || entry.controller.signal.aborted) return;
        entry.started = true;
        try {
            void this.request(entry.references, entry.controller.signal).then(
                (result) => {
                    if (!this.isCurrent(entry.capture)) {
                        entry.finish({ status: "superseded" });
                    } else if (result.status === "ready") {
                        const response = parseQueueAdmissionResponse(
                            result.response,
                            entry.references,
                        );
                        entry.finish(
                            response
                                ? { status: "ready", response }
                                : { status: "unavailable" },
                        );
                    } else {
                        entry.finish(
                            result.status === "legacy_exact"
                                ? { status: "legacy_exact" }
                                : { status: "unavailable" },
                        );
                    }
                },
                () => entry.finish({ status: "unavailable" }),
            );
        } catch {
            entry.finish({ status: "unavailable" });
        }
    }
}
