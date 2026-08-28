let authRuntimeGeneration = 0;

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

/** Retire every async callback that captured the previous auth runtime. */
export function advanceAuthRuntimeGeneration(): number {
    authRuntimeGeneration += 1;
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
