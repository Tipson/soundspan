interface AdaptivePollingIntervalOptions {
    enabled: boolean;
    hasActiveItems: boolean;
    activeIntervalMs: number;
    idleIntervalMs: number;
}

/**
 * Normalizes optional polling enable flags to the default-enabled contract.
 */
export function resolvePollingEnabled(enabled?: boolean): boolean {
    return enabled ?? true;
}

/**
 * Gates polling behind the admin role on top of the default-enabled
 * contract. Used for admin-only surfaces (e.g. the YouTube downloads list):
 * polling those endpoints as a non-admin would just 403-spam the backend.
 */
export function resolveAdminGatedPollingEnabled(
    enabled: boolean | undefined,
    role: string | null | undefined,
): boolean {
    return resolvePollingEnabled(enabled) && role === "admin";
}

/**
 * Resolves a fixed polling interval, returning false when polling is disabled.
 */
export function resolveFixedPollingInterval(
    enabled: boolean,
    intervalMs: number,
): number | false {
    return enabled ? intervalMs : false;
}

/**
 * Returns a random jitter value between 0 (inclusive) and maxJitterMs (exclusive).
 * Used to stagger polling intervals and prevent simultaneous network bursts.
 */
export function resolvePollingJitter(maxJitterMs: number): number {
    return Math.floor(Math.random() * maxJitterMs);
}

/**
 * Pauses a resolved polling interval while the document is hidden.
 * Returns the interval unchanged when visible, false otherwise.
 */
export function resolveVisibilityGatedPollingInterval(
    intervalMs: number | false,
    isDocumentVisible: boolean,
): number | false {
    return isDocumentVisible ? intervalMs : false;
}

/**
 * Resolves adaptive polling intervals, switching between active/idle cadences.
 */
export function resolveAdaptivePollingInterval(
    options: AdaptivePollingIntervalOptions,
): number | false {
    if (!options.enabled) {
        return false;
    }

    return options.hasActiveItems
        ? options.activeIntervalMs
        : options.idleIntervalMs;
}
