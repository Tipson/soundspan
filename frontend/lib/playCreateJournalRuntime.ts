import type { PlayEngagementInput, PlayLogInput } from "./api/plays";
import {
    createPlayCreateCoordinator,
    type PlayCreateCoordinator,
    type PlayCreateCoordinatorOptions,
    type PlayCreateTicket,
} from "./playCreateCoordinator";
import {
    admitPlayCreateGrant,
    type PlayCreateBinding,
    type PlayCreateGrant,
} from "./playCreateJournal";
import {
    createPlayCreateJournalStorage,
    type PlayCreateJournalStorage,
    type PlayCreateStorageLease,
} from "./playCreateJournalStorage";

/** The mounted authenticated audio owner is independent of mutable shared browser credentials. */
export interface PlayCreateJournalRuntimeOptions {
    ownerId: string;
    api: PlayCreateCoordinatorOptions["api"] & {
        getSessionGeneration(): number;
        getPlayCreateLoginNonce(): string | null;
        getPlayCreationGrant(options: {
            network: PlayCreateJournalRuntimeOptions["network"];
            signal: AbortSignal;
        }): Promise<PlayCreateGrant | null>;
    };
    auth: { isCurrent(): boolean; signal?: AbortSignal };
    network: { isOnline(): boolean; getGeneration(): number };
    databaseName?: string;
    nowMonotonic(): number;
    nonce(): string;
    schedule: PlayCreateCoordinatorOptions["schedule"];
}

/** Bind private durable delivery to one mounted login without controlling playback. */
export class PlayCreateJournalRuntime {
    private readonly options: PlayCreateJournalRuntimeOptions;
    private readonly authGeneration: number;
    private loginNonce: string | null;
    private historyEpoch: number | null = null;
    private lease: PlayCreateStorageLease | null = null;
    private actor: PlayCreateCoordinator | null = null;
    private readonly storage: PlayCreateJournalStorage;
    private controller = new AbortController();
    private preparing: Promise<void> | null = null;
    private closing: Promise<void> | null = null;
    private activation = 0;
    private closed = false;
    private ownerMismatch = false;
    private historyPending = 0;
    private historySucceeded = false;
    private readonly pendingWrites = new Set<Promise<unknown>>();
    private readonly authAbort = () => {
        void this.revoke();
    };

    constructor(options: PlayCreateJournalRuntimeOptions) {
        options = this.options = Object.freeze({
            ...options,
            auth: Object.freeze({ ...options.auth }),
            network: Object.freeze({ ...options.network }),
        });
        this.authGeneration = options.api.getSessionGeneration();
        this.loginNonce = options.api.getPlayCreateLoginNonce();
        this.storage = createPlayCreateJournalStorage({
            databaseName: options.databaseName,
            // Closing networking must not invalidate an accepted local final checkpoint.
            isCurrent: (scope) =>
                this.identityCurrent() &&
                scope.ownerId === options.ownerId &&
                scope.loginNonce === this.loginNonce &&
                scope.historyEpoch === this.historyEpoch,
        });
        options.auth.signal?.addEventListener("abort", this.authAbort, {
            once: true,
        });
    }

    private identityCurrent(): boolean {
        try {
            return (
                !this.ownerMismatch &&
                !!this.options.ownerId &&
                this.options.auth.isCurrent() &&
                !this.options.auth.signal?.aborted &&
                this.options.api.getSessionGeneration() ===
                    this.authGeneration &&
                (this.loginNonce === null ||
                    this.options.api.getPlayCreateLoginNonce() ===
                        this.loginNonce)
            );
        } catch {
            return false;
        }
    }

    private binding(): PlayCreateBinding | null {
        if (!this.identityCurrent() || !this.loginNonce) return null;
        return Object.freeze({
            ownerId: this.options.ownerId,
            loginNonce: this.loginNonce,
            authGeneration: this.authGeneration,
            networkGeneration: this.options.network.getGeneration(),
        });
    }

    private scope(grant: PlayCreateGrant) {
        const binding = this.binding();
        return (
            binding &&
            admitPlayCreateGrant(grant, {
                binding,
                online: this.options.network.isOnline(),
                nowMonotonicMs: this.options.nowMonotonic(),
                intent: { kind: "restore" },
            })
        );
    }

    private async readGrant(
        signal: AbortSignal,
    ): Promise<PlayCreateGrant | null> {
        if (
            this.closed ||
            this.historyPending ||
            !this.identityCurrent() ||
            !this.options.network.isOnline()
        )
            return null;
        const grant = await this.options.api.getPlayCreationGrant({
            network: this.options.network,
            signal,
        });
        if (
            !grant ||
            signal.aborted ||
            this.closed ||
            this.historyPending ||
            !this.identityCurrent()
        )
            return null;
        if (grant.binding.ownerId !== this.options.ownerId) {
            // A fresh /auth/me can precede React's cross-tab storage event. Never log the old UI queue as the new owner.
            this.ownerMismatch = true;
            this.actor?.close();
            this.actor = null;
            return null;
        }
        if (
            grant.binding.authGeneration !== this.authGeneration ||
            (this.loginNonce !== null &&
                this.loginNonce !== grant.binding.loginNonce)
        )
            return null;
        this.loginNonce = grant.binding.loginNonce;
        return this.scope(grant) ? grant : null;
    }

    private async activate(
        grant: PlayCreateGrant,
        activation: number,
    ): Promise<void> {
        const admitted = this.scope(grant),
            binding = this.binding();
        if (
            !admitted ||
            !binding ||
            this.closed ||
            this.historyPending ||
            activation !== this.activation
        )
            return;
        this.historyEpoch = admitted.historyEpoch;
        const lease = await this.storage.activateLease(
            {
                ownerId: binding.ownerId,
                loginNonce: binding.loginNonce,
                historyEpoch: admitted.historyEpoch,
            },
            this.options.nonce(),
        );
        if (
            !lease ||
            this.closed ||
            this.historyPending ||
            activation !== this.activation ||
            !this.scope(grant)
        )
            return;
        this.lease = lease;
        this.actor = createPlayCreateCoordinator({
            storage: this.storage,
            lease,
            binding,
            initialGrant: grant,
            getBinding: () => this.binding(),
            isOnline: () =>
                !this.closed &&
                this.historyPending === 0 &&
                this.options.network.isOnline(),
            nowMonotonic: this.options.nowMonotonic,
            nonce: this.options.nonce,
            schedule: this.options.schedule,
            api: this.options.api,
            readFreshGrant: async (signal) => {
                const next = await this.readGrant(signal);
                if (!next) return null;
                const scope = this.scope(next);
                if (!scope || scope.historyEpoch === lease.historyEpoch)
                    return next;
                this.actor?.close();
                this.actor = null;
                const version = ++this.activation;
                // The new epoch invalidates old storage callbacks before awaiting a replacement lease.
                this.historyEpoch = scope.historyEpoch;
                const adopting = this.activate(next, version)
                    .catch(() => undefined)
                    .finally(() => {
                        if (this.preparing === adopting) this.preparing = null;
                    });
                this.preparing = adopting;
                return null;
            },
        });
        this.actor.wake();
    }

    /** Prepare in the background; starting audio never waits for identity, IDB or a grant. */
    prepare(): Promise<void> {
        if (
            this.closed ||
            this.historyPending ||
            !this.identityCurrent() ||
            !this.options.network.isOnline()
        )
            return Promise.resolve();
        if (this.actor) {
            this.actor.wake();
            return Promise.resolve();
        }
        if (this.preparing) return this.preparing;
        const activation = this.activation;
        const pending = this.readGrant(this.controller.signal)
            .then((grant) =>
                grant ? this.activate(grant, activation) : undefined,
            )
            .catch(() => undefined)
            .finally(() => {
                if (this.preparing === pending) this.preparing = null;
            });
        this.preparing = pending;
        return pending;
    }

    private retain<T>(promise: Promise<T>): Promise<T> {
        this.pendingWrites.add(promise);
        void promise.then(
            () => this.pendingWrites.delete(promise),
            () => this.pendingWrites.delete(promise),
        );
        return promise;
    }

    /** Null permits legacy only before selection; a retired login/history barrier throws instead. */
    begin(input: PlayLogInput): PlayCreateTicket | null {
        if (this.closed || this.historyPending || !this.identityCurrent())
            throw new Error("Play accounting session is unavailable");
        const ticket = this.actor?.begin(input) ?? null;
        if (!ticket) return null;
        this.retain(ticket.persisted);
        return Object.freeze({
            ...ticket,
            noteEngagement: (totals: PlayEngagementInput, final: boolean) =>
                this.retain(ticket.noteEngagement(totals, final)),
        });
    }

    /** Network/visibility work is event-driven; no runtime permission polling is installed. */
    wake(): void {
        if (this.actor) this.actor.wake();
        else void this.prepare();
    }

    /** Wait for local checkpoint writes and the actor's current bounded delivery pass. */
    async flush(): Promise<void> {
        await this.preparing;
        await Promise.allSettled([...this.pendingWrites]);
        await this.actor?.flush();
    }

    /** Withdraw admission before a history DELETE; a failed DELETE can resume the original epoch. */
    suspendForHistoryClear(): (succeeded: boolean) => Promise<void> {
        this.historyPending++;
        this.activation++;
        this.controller.abort();
        this.controller = new AbortController();
        this.preparing = null;
        // Pause delivery, retaining live tickets/checkpoint writes until DELETE's outcome is known.
        this.actor?.wake();
        let finished = false;
        return async (succeeded) => {
            if (finished) return;
            finished = true;
            this.historySucceeded ||= succeeded;
            this.historyPending--;
            if (this.historyPending) return;
            const retire = this.historySucceeded;
            this.historySucceeded = false;
            if (retire) {
                this.actor?.close();
                this.actor = null;
            }
            await Promise.allSettled([...this.pendingWrites]);
            if (retire && this.lease)
                await this.storage.retireLease(this.lease).catch(() => false);
            if (retire) {
                this.lease = null;
                this.historyEpoch = null;
            }
            if (!this.closed) await this.prepare();
        };
    }

    private stop(retire: boolean): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        this.activation++;
        this.controller.abort();
        this.actor?.close();
        this.actor = null;
        this.options.auth.signal?.removeEventListener("abort", this.authAbort);
        this.closing = Promise.allSettled([...this.pendingWrites]).then(
            async () => {
                if (retire && this.lease)
                    await this.storage
                        .retireLease(this.lease)
                        .catch(() => false);
                await this.storage.close();
            },
        );
        return this.closing;
    }

    /** Stop this mounted runtime after accepted local writes, preserving same-login recovery. */
    close(): Promise<void> {
        return this.stop(false);
    }
    /** Logically stop immediately and conditionally retire its original durable lease. */
    revoke(): Promise<void> {
        return this.stop(true);
    }
}

/** One instance belongs to one authenticated audio mount, never a cached global feature object. */
export function createPlayCreateJournalRuntime(
    options: PlayCreateJournalRuntimeOptions,
): PlayCreateJournalRuntime {
    return new PlayCreateJournalRuntime(options);
}
