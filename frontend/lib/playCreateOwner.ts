import type { ApiClientCore } from "./api/core";
import type { PlayCreateBinding } from "./playCreateJournal";

type Dependencies = {
    api: Pick<
        ApiClientCore,
        "initToken" | "getSessionGeneration" | "getPlayCreateLoginNonce"
    >;
    /** Make a fresh no-store HTTP identity request through the frontend API boundary. */
    readFreshOwner(signal: AbortSignal): Promise<unknown>;
    network: { isOnline(): boolean; getGeneration(): number };
};

type Snapshot = {
    authGeneration: number;
    loginNonce: string | null;
    networkGeneration: number;
};

function snapshot(dependencies: Dependencies): Snapshot | null {
    const authGeneration = dependencies.api.getSessionGeneration();
    const loginNonce = dependencies.api.getPlayCreateLoginNonce();
    const networkGeneration = dependencies.network.getGeneration();
    if (
        !dependencies.network.isOnline() ||
        !Number.isSafeInteger(authGeneration) ||
        authGeneration < 0 ||
        !Number.isSafeInteger(networkGeneration) ||
        networkGeneration < 0 ||
        !(
            loginNonce === null ||
            (typeof loginNonce === "string" && loginNonce.length > 0)
        )
    )
        return null;
    return { authGeneration, loginNonce, networkGeneration };
}

function ownerId(value: unknown): string | null {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "id");
    const id: unknown =
        descriptor && "value" in descriptor ? descriptor.value : null;
    return typeof id === "string" && id.trim().length > 0 && id.length <= 128
        ? id
        : null;
}

/**
 * Prepare an online owner binding, never a capability or cached-UI admission.
 * The injected identity reader owns fresh HTTP/no-store provenance and bounded I/O.
 */
export async function preparePlayCreateOwner(
    dependencies: Dependencies,
    options: { signal?: AbortSignal } = {},
): Promise<PlayCreateBinding | null> {
    const controller = new AbortController();
    const outerSignal = options.signal;
    if (outerSignal?.aborted) return null;
    const forwardAbort = () => controller.abort(outerSignal?.reason);
    outerSignal?.addEventListener("abort", forwardAbort, { once: true });

    const current = (expected: Snapshot): boolean => {
        const actual = snapshot(dependencies);
        return (
            !controller.signal.aborted &&
            actual !== null &&
            actual.authGeneration === expected.authGeneration &&
            actual.loginNonce === expected.loginNonce &&
            actual.networkGeneration === expected.networkGeneration
        );
    };
    try {
        let captured = snapshot(dependencies);
        if (!captured || !current(captured)) return null;
        if (captured.loginNonce === null) {
            await dependencies.api.initToken();
            const restored = snapshot(dependencies);
            if (
                controller.signal.aborted ||
                !restored ||
                restored.authGeneration !== captured.authGeneration ||
                restored.networkGeneration !== captured.networkGeneration ||
                restored.loginNonce === null
            )
                return null;
            captured = restored;
        }
        if (!current(captured) || captured.loginNonce === null) return null;
        // Always pass an explicit private signal, including without an outer signal:
        // ApiClientCore then keeps this identity read out of shared GET coalescing.
        const rawOwner = await dependencies.readFreshOwner(controller.signal);
        if (!current(captured)) return null;
        const id = ownerId(rawOwner);
        if (id === null || !current(captured)) return null;
        return Object.freeze({
            ownerId: id,
            loginNonce: captured.loginNonce,
            authGeneration: captured.authGeneration,
            networkGeneration: captured.networkGeneration,
        });
    } catch {
        return null;
    } finally {
        outerSignal?.removeEventListener("abort", forwardAbort);
    }
}
