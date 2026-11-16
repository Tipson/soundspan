import type {
    PlayEngagementInput,
    PlayEngagementResponse,
    PlayLogResponse,
} from "./api/plays";
import { frontendLogger } from "./logger";
import {
    admitPlayCreateGrant,
    makePlayCreateKey,
    projectPlayCreatePayload,
    readPlayCreateKey,
    type PlayCreateAdmission,
    type PlayCreateBinding,
    type PlayCreateGrant,
    type PlayCreatePayload,
} from "./playCreateJournal";
import type {
    PlayCreateJournalStorage,
    PlayCreateStorageLease,
    PlayCreateStoredRow,
} from "./playCreateJournalStorage";
import {
    readPlayCreateAck,
    readPlayEngagementAck,
    type PlayCreateWireAck,
} from "./playCreateWire";

const logger = frontendLogger.child("PlayCreateCoordinator");
const automaticCreateAgeMs = 600_000;
const passDurationMs = 15_000;
const maxPassOperations = 10;
const maxTickets = 100;
const maxServerDateMs = 8_640_000_000_000_000;
const outcomes = ["failed", "skipped", "meaningful", "completed"] as const;

/** A keyed selection never falls back, even when persistence or its response fails. */
export interface PlayCreateTicket {
    readonly key: string;
    readonly mode: "keyed";
    readonly persisted: Promise<boolean>;
    readonly created: Promise<PlayLogResponse>;
    noteEngagement(
        input: PlayEngagementInput,
        final: boolean,
    ): Promise<boolean>;
}

/** Browser composition supplies clocks, crypto, verified bindings and the existing API boundary. */
export interface PlayCreateCoordinatorOptions {
    storage: PlayCreateJournalStorage;
    lease: PlayCreateStorageLease;
    binding: PlayCreateBinding;
    initialGrant: PlayCreateGrant | null;
    getBinding(): PlayCreateBinding | null;
    isOnline(): boolean;
    nowMonotonic(): number;
    readFreshGrant(signal: AbortSignal): Promise<PlayCreateGrant | null>;
    nonce(): string;
    schedule(run: () => void, delayMs: number): () => void;
    api: {
        createPlayIdempotent(
            key: string,
            payload: PlayCreatePayload,
            options: { binding: PlayCreateBinding; signal: AbortSignal },
        ): Promise<PlayCreateWireAck>;
        updatePlayEngagementIdempotent(
            playId: string,
            input: PlayEngagementInput,
            options: { binding: PlayCreateBinding; signal: AbortSignal },
        ): Promise<PlayEngagementResponse>;
    };
}

type PendingTotals = { input: PlayEngagementInput; final: boolean };
type TicketState = {
    persisted: Promise<boolean>;
    isPersisted: boolean;
    settled: boolean;
    resolve(response: PlayLogResponse): void;
    reject(error: Error): void;
    pending: PendingTotals | null;
    writing: Promise<boolean> | null;
};
type AdmissionIntent = Parameters<typeof admitPlayCreateGrant>[1]["intent"];

function sameLogin(a: PlayCreateBinding, b: PlayCreateBinding): boolean {
    return (
        a.ownerId === b.ownerId &&
        a.loginNonce === b.loginNonce &&
        a.authGeneration === b.authGeneration
    );
}

function copiedTotals(input: PlayEngagementInput): PlayEngagementInput | null {
    try {
        if (
            !input ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
            Reflect.ownKeys(input).length !== 3
        )
            return null;
        const values = ["listenedSeconds", "completionRatio", "outcome"].map(
            (name) => Object.getOwnPropertyDescriptor(input, name),
        );
        if (values.some((value) => !value || !("value" in value))) return null;
        const [seconds, ratio, outcome] = values.map((value) => value!.value);
        return typeof seconds === "number" &&
            Number.isFinite(seconds) &&
            seconds >= 0 &&
            seconds <= 86_400 &&
            typeof ratio === "number" &&
            Number.isFinite(ratio) &&
            ratio >= 0 &&
            ratio <= 1 &&
            outcomes.includes(outcome)
            ? { listenedSeconds: seconds, completionRatio: ratio, outcome }
            : null;
    } catch {
        return null;
    }
}

function mergeTotals(a: PendingTotals, b: PendingTotals): PendingTotals {
    return {
        input: {
            listenedSeconds: Math.max(
                a.input.listenedSeconds,
                b.input.listenedSeconds,
            ),
            completionRatio: Math.max(
                a.input.completionRatio,
                b.input.completionRatio,
            ),
            outcome:
                outcomes[
                    Math.max(
                        outcomes.indexOf(a.input.outcome),
                        outcomes.indexOf(b.input.outcome),
                    )
                ],
        },
        final: a.final || b.final,
    };
}

/** Deliver one private owner/login/history journal without controlling audio or queue state. */
export class PlayCreateCoordinator {
    private readonly binding: PlayCreateBinding;
    private readonly lease: PlayCreateStorageLease;
    private grant: PlayCreateGrant | null;
    private anchor: { serverNowMs: number; monotonicMs: number } | null = null;
    private lastMonotonicMs = 0;
    private closed = false;
    private running: Promise<void> | null = null;
    private controller: AbortController | null = null;
    private cancelTimer: (() => void) | null = null;
    private workVersion = 0;
    private localTail: Promise<unknown> = Promise.resolve();
    private readonly tickets = new Map<string, TicketState>();

    constructor(private readonly options: PlayCreateCoordinatorOptions) {
        this.binding = Object.freeze({ ...options.binding });
        this.lease = Object.freeze({ ...options.lease });
        this.grant = options.initialGrant;
    }

    private now(): number | null {
        try {
            const value = this.options.nowMonotonic();
            if (
                !Number.isFinite(value) ||
                value < this.lastMonotonicMs ||
                value < 0
            ) {
                this.grant = null;
                this.anchor = null;
                return null;
            }
            this.lastMonotonicMs = value;
            return value;
        } catch {
            return null;
        }
    }

    private current(): PlayCreateBinding | null {
        try {
            const current = this.options.getBinding();
            return current &&
                sameLogin(current, this.binding) &&
                this.lease.ownerId === current.ownerId &&
                this.lease.loginNonce === current.loginNonce
                ? Object.freeze({ ...current })
                : null;
        } catch {
            return null;
        }
    }

    private online(): boolean {
        try {
            return this.options.isOnline() === true;
        } catch {
            return false;
        }
    }

    private admission(intent: AdmissionIntent): PlayCreateAdmission | null {
        const current = this.current(),
            monotonicMs = this.now();
        if (this.closed || !current || monotonicMs === null || !this.grant)
            return null;
        const admitted = admitPlayCreateGrant(this.grant, {
            binding: current,
            nowMonotonicMs: monotonicMs,
            online: this.online(),
            intent,
        });
        if (!admitted || admitted.historyEpoch !== this.lease.historyEpoch)
            return null;
        this.anchor = { serverNowMs: admitted.serverNowMs, monotonicMs };
        return admitted;
    }

    /** Clock projection alone cannot authorize another network operation. */
    private projectedNow(): number | null {
        const now = this.now();
        if (now === null || !this.anchor || now < this.anchor.monotonicMs)
            return null;
        const value = this.anchor.serverNowMs + now - this.anchor.monotonicMs;
        return Number.isFinite(value) && value <= maxServerDateMs
            ? value
            : null;
    }

    private enqueue<T>(run: () => Promise<T>): Promise<T> {
        const next = this.localTail.then(run);
        this.localTail = next.catch(() => undefined);
        return next;
    }

    private settle(state: TicketState, response?: PlayLogResponse): void {
        if (state.settled) return;
        state.settled = true;
        if (response) state.resolve(Object.freeze({ id: response.id }));
        else state.reject(new Error("Play creation is no longer available"));
    }

    /** Select synchronously from an already fresh grant; null permits the caller's legacy selection. */
    begin(rawPayload: unknown): PlayCreateTicket | null {
        if (this.closed || this.tickets.size >= maxTickets) return null;
        const payload = projectPlayCreatePayload(rawPayload);
        const admitted =
            payload && this.admission({ kind: "new", source: payload.source });
        if (!payload || !admitted) return null;
        let key: ReturnType<typeof makePlayCreateKey>;
        try {
            key = makePlayCreateKey(
                admitted.historyEpoch,
                admitted.serverNowMs,
                this.options.nonce(),
            );
        } catch {
            return null;
        }
        if (!key || this.tickets.has(key.value)) return null;
        let resolve!: TicketState["resolve"], reject!: TicketState["reject"];
        const created = new Promise<PlayLogResponse>((done, fail) => {
            resolve = done;
            reject = fail;
        });
        // A caller may only observe persistence; never leave an abandoned creation rejection unhandled.
        void created.catch(() => undefined);
        const state: TicketState = {
            persisted: Promise.resolve(false),
            isPersisted: false,
            settled: false,
            resolve,
            reject,
            pending: null,
            writing: null,
        };
        this.tickets.set(key.value, state);
        const capturedKey = key.value;
        state.persisted = this.enqueue(async () => {
            if (!this.current()) return false;
            return this.options.storage.insertReady(this.lease, {
                key: capturedKey,
                payload,
            });
        })
            .catch(() => false)
            .then((stored) => {
                state.isPersisted = stored;
                if (!stored) {
                    this.settle(state);
                    this.tickets.delete(capturedKey);
                } else this.wake();
                return stored;
            });
        return Object.freeze({
            key: capturedKey,
            mode: "keyed" as const,
            persisted: state.persisted,
            created,
            noteEngagement: (input: PlayEngagementInput, final: boolean) =>
                this.checkpoint(capturedKey, state, input, final),
        });
    }

    private checkpoint(
        key: string,
        state: TicketState,
        input: PlayEngagementInput,
        final: boolean,
    ): Promise<boolean> {
        const copied = copiedTotals(input);
        if (
            this.closed ||
            !this.current() ||
            !copied ||
            typeof final !== "boolean"
        )
            return Promise.resolve(false);
        const next = { input: copied, final };
        state.pending = state.pending ? mergeTotals(state.pending, next) : next;
        if (state.writing) return state.writing;
        return this.writeCheckpoint(key, state);
    }

    private writeCheckpoint(key: string, state: TicketState): Promise<boolean> {
        state.writing = this.enqueue(async () => {
            if (!(await state.persisted)) return false;
            let stored = true;
            while (state.pending && this.current()) {
                const pending = state.pending;
                state.pending = null;
                stored = await this.options.storage.mergeEngagement(
                    this.lease,
                    key,
                    pending.input,
                    pending.final,
                );
                if (!stored) break;
            }
            return stored;
        })
            .catch(() => false)
            .then((stored) => {
                state.writing = null;
                // A note may join after the drain returned but before this promise settles.
                // Adopt its next write so every accepted caller observes durable completion.
                if (stored && state.pending && this.current())
                    return this.writeCheckpoint(key, state);
                if (stored) this.wake();
                return stored;
            });
        return state.writing;
    }

    private stopTimer(): void {
        this.cancelTimer?.();
        this.cancelTimer = null;
    }

    private schedule(delayMs: number): void {
        this.stopTimer();
        if (this.closed || !this.current() || !this.online()) return;
        this.cancelTimer = this.options.schedule(
            () => {
                this.cancelTimer = null;
                this.wake();
            },
            Math.max(1, Math.min(86_400_000, delayMs)),
        );
    }

    /** Positive external work/network events request one pass; there is no permission polling timer. */
    wake(): void {
        this.workVersion++;
        if (!this.online()) {
            this.grant = null;
            this.stopTimer();
            this.controller?.abort();
            return;
        }
        void this.flush();
    }

    /** Await the current bounded pass; budget followups remain separately scheduled. */
    flush(): Promise<void> {
        if (this.running) return this.running;
        if (this.closed || !this.current() || !this.online()) {
            this.stopTimer();
            return Promise.resolve();
        }
        this.stopTimer();
        const startedVersion = this.workVersion;
        let observedVersion: number | undefined;
        const controller = new AbortController();
        this.controller = controller;
        const running = this.pass(controller)
            .then((version) => {
                observedVersion = version;
            })
            .catch(() => {
                logger.warn("Play journal pass could not finish");
            })
            .finally(() => {
                this.running = null;
                if (this.controller === controller) this.controller = null;
                if (
                    this.workVersion !== (observedVersion ?? startedVersion) &&
                    !this.closed &&
                    this.current() &&
                    this.online()
                )
                    this.schedule(100);
            });
        this.running = running;
        return running;
    }

    private syncTickets(rows: PlayCreateStoredRow[]): void {
        for (const [key, state] of this.tickets) {
            const row = rows.find((value) => value.key === key);
            if (row?.state === "known" && row.playId)
                this.settle(state, { id: row.playId });
            else if (row?.state === "terminal") this.settle(state);
            else if (!row && state.isPersisted) {
                this.settle(state);
                this.tickets.delete(key);
            }
        }
    }

    private sendCurrent(
        binding: PlayCreateBinding,
        controller: AbortController,
    ): boolean {
        const current = this.current();
        return (
            !this.closed &&
            !controller.signal.aborted &&
            this.online() &&
            !!current &&
            current.networkGeneration === binding.networkGeneration
        );
    }

    private async pass(
        controller: AbortController,
    ): Promise<number | undefined> {
        await this.localTail;
        if (
            this.closed ||
            !this.current() ||
            !this.online() ||
            controller.signal.aborted
        )
            return;
        let snapshot = await this.options.storage.snapshot(this.lease);
        if (
            !snapshot ||
            this.closed ||
            !this.current() ||
            !this.online() ||
            controller.signal.aborted
        )
            return;
        this.syncTickets(snapshot.rows);
        let admitted = this.admission({ kind: "restore" });
        if (!admitted) {
            this.grant = await this.options.readFreshGrant(controller.signal);
            admitted = this.admission({ kind: "restore" });
        }
        if (!admitted || controller.signal.aborted) return;
        // A positive wake also refreshes admission for the next run after idle/offline, even with no rows.
        if (!snapshot.rows.length) return;
        await this.options.storage.pruneExpired(
            this.lease,
            admitted.serverNowMs,
        );
        const startedAt = this.now();
        if (startedAt === null) return;
        let operations = 0;
        const visited = new Set<string>();
        while (operations < maxPassOperations) {
            const now = this.now();
            admitted = this.admission({ kind: "restore" });
            if (
                now === null ||
                now - startedAt >= passDurationMs ||
                !admitted ||
                controller.signal.aborted
            )
                break;
            snapshot = await this.options.storage.snapshot(this.lease);
            if (!snapshot) return;
            this.syncTickets(snapshot.rows);
            const serverNowMs = admitted.serverNowMs;
            // Pure local retirement is allowed by the fresh scope, independently of create flags.
            for (const row of snapshot.rows) {
                const key = readPlayCreateKey(row.key)!;
                if (
                    (row.state === "ready" || row.state === "unknown") &&
                    (!row.createClaim ||
                        row.createClaim.expiresAtServerMs <= serverNowMs) &&
                    (row.createAttempts >= 3 ||
                        serverNowMs - key.issuedAtMs >= automaticCreateAgeMs)
                ) {
                    await this.options.storage.reserveCreate(
                        this.lease,
                        row.key,
                        this.options.nonce(),
                        serverNowMs,
                    );
                    visited.add(row.key);
                    const ticket = this.tickets.get(row.key);
                    if (ticket) this.settle(ticket);
                }
            }
            const row = snapshot.rows.find((value) => {
                const key = readPlayCreateKey(value.key)!;
                if (
                    visited.has(value.key) ||
                    value.state === "terminal" ||
                    serverNowMs >= key.expiresAtMs ||
                    Math.max(
                        snapshot!.sharedHoldoffUntilMs,
                        value.holdoffUntilMs,
                    ) > serverNowMs
                )
                    return false;
                if (value.state === "known")
                    return (
                        !!value.totals &&
                        value.engagementRevision > value.ackRevision &&
                        (!value.patchClaim ||
                            value.patchClaim.expiresAtServerMs <= serverNowMs)
                    );
                if (
                    value.createClaim &&
                    value.createClaim.expiresAtServerMs > serverNowMs
                )
                    return false;
                const intent: AdmissionIntent =
                    value.createAttempts === 0
                        ? { kind: "new", source: value.source }
                        : { kind: "replay", key: value.key };
                return !!this.admission(intent);
            });
            if (!row) break;
            const binding = this.current();
            if (!binding) return;
            const kind = row.state === "known" ? "patch" : "create";
            const token = this.options.nonce();
            const reserved =
                kind === "create"
                    ? await this.options.storage.reserveCreate(
                          this.lease,
                          row.key,
                          token,
                          serverNowMs,
                      )
                    : await this.options.storage.reservePatch(
                          this.lease,
                          row.key,
                          token,
                          serverNowMs,
                      );
            if (!reserved) {
                visited.add(row.key);
                continue;
            }
            const intent: AdmissionIntent =
                kind === "patch"
                    ? { kind: "restore" }
                    : row.createAttempts === 0
                      ? { kind: "new", source: row.source }
                      : { kind: "replay", key: row.key };
            if (
                !this.sendCurrent(binding, controller) ||
                !this.admission(intent)
            )
                break;
            operations++;
            try {
                if (kind === "create") {
                    const raw = await this.options.api.createPlayIdempotent(
                        row.key,
                        Object.freeze({
                            source: row.source,
                            wireJson: row.wireJson,
                        }),
                        { binding, signal: controller.signal },
                    );
                    if (!this.sendCurrent(binding, controller)) break;
                    const ack = readPlayCreateAck(raw, row.key);
                    if (!ack)
                        throw new Error(
                            "Invalid Play creation acknowledgement",
                        );
                    if (
                        await this.options.storage.acknowledgeCreate(
                            this.lease,
                            row.key,
                            token,
                            ack.id,
                        )
                    ) {
                        const ticket = this.tickets.get(row.key);
                        if (ticket) this.settle(ticket, ack);
                    }
                } else {
                    const raw =
                        await this.options.api.updatePlayEngagementIdempotent(
                            reserved.playId!,
                            reserved.totals!,
                            { binding, signal: controller.signal },
                        );
                    if (!this.sendCurrent(binding, controller)) break;
                    if (!readPlayEngagementAck(raw))
                        throw new Error(
                            "Invalid Play engagement acknowledgement",
                        );
                    await this.options.storage.acknowledgePatch(
                        this.lease,
                        row.key,
                        token,
                    );
                }
            } catch (error) {
                if (!this.sendCurrent(binding, controller)) break;
                const failureNow = this.projectedNow();
                if (failureNow === null) break;
                const status = this.errorNumber(error, "status");
                const terminal =
                    [400, 401, 403, 404, 409, 410].includes(status ?? 0) ||
                    (kind === "create" && reserved.createAttempts >= 3);
                const shared = status === 429 || status === 503;
                const retry = shared
                    ? this.retryDelay(error)
                    : kind === "create"
                      ? 5000 * 2 ** (reserved.createAttempts - 1)
                      : 30_000;
                await this.options.storage.settleFailure(this.lease, row.key, {
                    kind,
                    token,
                    serverNowMs: failureNow,
                    retryAfterUntilMs: Math.min(
                        maxServerDateMs,
                        failureNow + retry,
                    ),
                    shared,
                    terminal,
                });
                if (terminal) {
                    const ticket = this.tickets.get(row.key);
                    if (ticket) this.settle(ticket);
                }
                visited.add(row.key);
                if (shared) break;
            }
        }
        const projected = this.projectedNow();
        if (
            projected === null ||
            this.closed ||
            !this.current() ||
            !this.online() ||
            controller.signal.aborted
        )
            return;
        const observedVersion = this.workVersion;
        snapshot = await this.options.storage.snapshot(this.lease);
        if (!snapshot) return;
        this.syncTickets(snapshot.rows);
        this.scheduleNearest(
            snapshot,
            projected,
            operations >= maxPassOperations ||
                (this.now() ?? startedAt) - startedAt >= passDurationMs,
        );
        return observedVersion;
    }

    private errorNumber(error: unknown, name: string): number | null {
        try {
            const value =
                error && typeof error === "object"
                    ? Object.getOwnPropertyDescriptor(error, name)?.value
                    : null;
            return typeof value === "number" &&
                Number.isFinite(value) &&
                value >= 0
                ? value
                : null;
        } catch {
            return null;
        }
    }

    private retryDelay(error: unknown): number {
        const delay = this.errorNumber(error, "retryAfterMs");
        if (delay === null) return 30_000;
        let elapsed = 0;
        try {
            const receipt = Object.getOwnPropertyDescriptor(
                error,
                "responseReceipt",
            )?.value;
            const received = this.errorNumber(receipt, "receivedMonotonicMs");
            const now = this.now();
            if (received !== null && now !== null && now >= received)
                elapsed = now - received;
        } catch {
            /* A missing numeric receipt keeps the full conservative delay. */
        }
        return Math.max(1000, Math.min(86_400_000, delay) - elapsed);
    }

    private scheduleNearest(
        snapshot: { rows: PlayCreateStoredRow[]; sharedHoldoffUntilMs: number },
        serverNowMs: number,
        budgetExhausted: boolean,
    ): void {
        let nearest = Infinity;
        for (const row of snapshot.rows) {
            const key = readPlayCreateKey(row.key)!;
            nearest = Math.min(nearest, key.expiresAtMs - serverNowMs);
            if (row.state === "terminal") continue;
            const pendingPatch =
                row.state === "known" &&
                !!row.totals &&
                row.engagementRevision > row.ackRevision;
            const pendingCreate =
                row.state === "ready" || row.state === "unknown";
            if (!pendingPatch && !pendingCreate) continue;
            const holdoff = Math.max(
                snapshot.sharedHoldoffUntilMs,
                row.holdoffUntilMs,
            );
            const claim = pendingPatch ? row.patchClaim : row.createClaim;
            const due = Math.max(holdoff, claim?.expiresAtServerMs ?? 0);
            if (due > serverNowMs)
                nearest = Math.min(nearest, due - serverNowMs);
            else if (budgetExhausted) nearest = Math.min(nearest, 100);
            if (
                pendingCreate &&
                !claim &&
                serverNowMs < key.issuedAtMs + automaticCreateAgeMs
            )
                nearest = Math.min(
                    nearest,
                    key.issuedAtMs + automaticCreateAgeMs - serverNowMs,
                );
        }
        if (Number.isFinite(nearest)) this.schedule(nearest);
    }

    /** Stop this tab only; already queued local writes and durable obligations survive reload. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.grant = null;
        this.stopTimer();
        this.controller?.abort();
        for (const state of this.tickets.values()) this.settle(state);
        this.tickets.clear();
    }

    /** Retire only the captured durable lease after synchronous history/logout admission withdrawal. */
    revoke(): Promise<boolean> {
        this.close();
        return this.enqueue(() =>
            this.options.storage.retireLease(this.lease),
        ).catch(() => false);
    }
}

/** Construct only after the runtime has verified the mounted owner and activated its private lease. */
export function createPlayCreateCoordinator(
    options: PlayCreateCoordinatorOptions,
): PlayCreateCoordinator {
    return new PlayCreateCoordinator(options);
}
