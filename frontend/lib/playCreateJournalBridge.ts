import type { PlayLogInput } from "./api/plays";
import {
    isCurrentAuthRuntime,
    type AuthRuntimeLease,
} from "./auth-runtime-generation";
import type { PlayCreateTicket } from "./playCreateCoordinator";
import type { PlayCreateJournalRuntime } from "./playCreateJournalRuntime";
import { frontendLogger } from "./logger";

type Runtime = Pick<
    PlayCreateJournalRuntime,
    "begin" | "close" | "suspendForHistoryClear"
>;
type Registration = {
    runtime: Runtime;
    api: object;
    authLease: AuthRuntimeLease;
    retired: boolean;
    finalizers: Set<() => void>;
};
const logger = frontendLogger.child("PlayCreateJournalBridge");
let current: Registration | null = null;

function isCurrent(lease: AuthRuntimeLease): boolean {
    return !lease.signal.aborted && isCurrentAuthRuntime(lease.generation);
}
function close(runtime: Runtime): void {
    try {
        void runtime
            .close()
            .catch(() => logger.warn("Play journal close failed"));
    } catch {
        logger.warn("Play journal close failed");
    }
}
function retire(registration: Registration): void {
    if (registration.retired) return;
    registration.retired = true;
    // Parent layout cleanup precedes child passive cleanup: capture final before closing delivery.
    for (const finalizer of registration.finalizers) {
        try {
            finalizer();
        } catch {
            logger.warn("Play journal finalization failed");
        }
    }
    registration.finalizers.clear();
    if (current === registration) current = null;
    close(registration.runtime);
}

/** Install only from the authenticated audio provider; stale cleanup cannot remove a newer owner. */
export function installPlayCreateJournalBridge(input: {
    runtime: Runtime;
    api: object;
    authLease: AuthRuntimeLease;
}): () => void {
    const authLease = Object.freeze({ ...input.authLease });
    if (!isCurrent(authLease)) {
        close(input.runtime);
        return () => undefined;
    }
    if (current) retire(current);
    const registration: Registration = {
        runtime: input.runtime,
        api: input.api,
        authLease,
        retired: false,
        finalizers: new Set(),
    };
    current = registration;
    return () => retire(registration);
}

/** One hook mount may bind its first provider, but can never adopt a replacement owner/runtime. */
export function createPlayJournalDeliveryScope(auth: AuthRuntimeLease): {
    assertCurrent(): void;
    begin(input: PlayLogInput): PlayCreateTicket | null;
    registerFinalizer(finalize: () => void): () => void;
} {
    const authLease = Object.freeze({ ...auth });
    let bound: Registration | null = null;
    const registration = (): Registration | null => {
        if (!isCurrent(authLease))
            throw new Error("Play accounting session was retired");
        if (bound && (bound.retired || bound !== current))
            throw new Error("Play accounting runtime was replaced");
        if (
            current &&
            (current.authLease.generation !== authLease.generation ||
                current.authLease.signal !== authLease.signal)
        )
            throw new Error("Play accounting owner was replaced");
        if (!bound && current) bound = current;
        return bound;
    };
    return Object.freeze({
        assertCurrent: () => {
            registration();
        },
        begin: (input: PlayLogInput) =>
            registration()?.runtime.begin(input) ?? null,
        registerFinalizer: (finalize: () => void) => {
            let captured: Registration | null;
            try {
                captured = registration();
            } catch {
                return () => undefined;
            }
            if (!captured) return () => undefined;
            captured.finalizers.add(finalize);
            return () => captured.finalizers.delete(finalize);
        },
    });
}

/** Suspend before DELETE, capturing its original API/runtime rather than consulting a later installation. */
export function suspendPlayCreateJournalHistory(
    api: object,
): (succeeded: boolean) => void {
    const registration = current;
    if (
        !registration ||
        registration.api !== api ||
        registration.retired ||
        !isCurrent(registration.authLease)
    )
        return () => undefined;
    let finish: ReturnType<Runtime["suspendForHistoryClear"]>;
    try {
        finish = registration.runtime.suspendForHistoryClear();
    } catch {
        logger.warn("Play journal history barrier failed");
        return () => undefined;
    }
    let finished = false;
    return (succeeded) => {
        if (finished) return;
        finished = true;
        try {
            void finish(succeeded).catch(() =>
                logger.warn("Play journal history recovery failed"),
            );
        } catch {
            logger.warn("Play journal history recovery failed");
        }
    };
}
