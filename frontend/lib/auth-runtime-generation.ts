let authRuntimeGeneration = 0;
let authRuntimeAbortController = new AbortController();

/** Identity and cancellation signal for one same-tab authenticated runtime. */
export interface AuthRuntimeLease {
    generation: number;
    signal: AbortSignal;
}

/** Same-tab signal that removes React state owned by the retired account. */
export const AUTH_RUNTIME_REVOKED_EVENT = "auth:runtime-revoked";

/** Error returned when async work belongs to a superseded auth runtime. */
export class SupersededAuthRuntimeError extends Error {
    constructor() {
        super("Authentication session changed while the operation was pending");
        this.name = "SupersededAuthRuntimeError";
    }
}

/** Capture the current in-tab authentication runtime generation. */
export function getAuthRuntimeGeneration(): number {
    return authRuntimeGeneration;
}

/** Capture a lease that is aborted synchronously when credentials rotate. */
export function getAuthRuntimeLease(): AuthRuntimeLease {
    return {
        generation: authRuntimeGeneration,
        signal: authRuntimeAbortController.signal,
    };
}

/** Retire every async callback that captured the previous auth runtime. */
export function advanceAuthRuntimeGeneration(): number {
    authRuntimeAbortController.abort();
    authRuntimeGeneration += 1;
    authRuntimeAbortController = new AbortController();
    return authRuntimeGeneration;
}

/** Reject work whose owning authentication runtime has been superseded. */
export function assertCurrentAuthRuntime(generation: number): void {
    if (generation !== authRuntimeGeneration) {
        throw new SupersededAuthRuntimeError();
    }
}

/** Check ownership without exposing credential or user identifiers. */
export function isCurrentAuthRuntime(generation: number): boolean {
    return generation === authRuntimeGeneration;
}
