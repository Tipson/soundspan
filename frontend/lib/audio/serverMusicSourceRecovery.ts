import type { MusicSourceRecording } from "../api/musicSources";

/** Immutable occurrence and confirmed timeline captured before replacing a transport. */
export interface ServerSourceRecoveryInput {
    key: string;
    recording: MusicSourceRecording;
    positionSec: number;
}

/** Terminal outcomes distinguish an obsolete user intent from a failed replacement. */
export type ServerSourceRecoveryOutcome =
    | "not_applicable"
    | "in_progress"
    | "recovered"
    | "stale"
    | "no_candidate"
    | "failed"
    | "exhausted";

interface Dependencies {
    isCurrent(input: ServerSourceRecoveryInput): boolean;
    resolve(
        recording: MusicSourceRecording,
        signal: AbortSignal,
    ): Promise<string | null>;
    apply(
        url: string,
        input: ServerSourceRecoveryInput,
        signal: AbortSignal,
    ): Promise<void>;
    timeoutMs?: number;
}

/** Own one bounded replacement per load; duplicate engine errors never multiply requests. */
export function createServerMusicSourceRecovery(deps: Dependencies) {
    let attemptedKey: string | null = null;
    let pending: {
        key: string;
        controller: AbortController;
        cancelled: boolean;
    } | null = null;

    const cancel = () => {
        if (pending) {
            pending.cancelled = true;
            pending.controller.abort();
        }
    };

    return {
        cancel,
        reset() {
            cancel();
            attemptedKey = null;
        },
        async recover(
            input: ServerSourceRecoveryInput,
        ): Promise<ServerSourceRecoveryOutcome> {
            if (!deps.isCurrent(input)) return "stale";
            if (pending?.key === input.key) return "in_progress";
            if (attemptedKey === input.key) return "exhausted";
            cancel();
            attemptedKey = input.key;
            const operation = {
                key: input.key,
                controller: new AbortController(),
                cancelled: false,
            };
            pending = operation;
            const { signal } = operation.controller;
            const timer = setTimeout(
                () => operation.controller.abort(),
                deps.timeoutMs ?? 30_000,
            );
            let abort = () => {};
            const cancelled = new Promise<never>((_, reject) => {
                abort = () =>
                    reject(
                        new DOMException("Recovery interrupted", "AbortError"),
                    );
                signal.addEventListener("abort", abort, { once: true });
            });
            try {
                const url = await Promise.race([
                    deps.resolve(input.recording, signal),
                    cancelled,
                ]);
                if (!deps.isCurrent(input) || operation.cancelled)
                    return "stale";
                signal.throwIfAborted();
                if (!url) return "no_candidate";
                await Promise.race([deps.apply(url, input, signal), cancelled]);
                return deps.isCurrent(input) && !signal.aborted
                    ? "recovered"
                    : "stale";
            } catch {
                return operation.cancelled || !deps.isCurrent(input)
                    ? "stale"
                    : "failed";
            } finally {
                clearTimeout(timer);
                signal.removeEventListener("abort", abort);
                if (pending === operation) pending = null;
            }
        },
    };
}
