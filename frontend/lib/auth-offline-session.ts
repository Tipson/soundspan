export interface CachedAuthUser {
    id: string;
    username: string;
    displayName?: string | null;
    email?: string | null;
    role: string;
    onboardingComplete?: boolean;
}

const CACHED_AUTH_USER_KEY = "soundspan_cached_auth_user_v1";
export const AUTH_SESSION_CHANGE_KEY = "soundspan_auth_session_change_v1";

type AuthStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type AuthSignalStorage = Pick<Storage, "setItem">;

function createOpaqueSessionSignal(): string {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Notify other same-origin tabs without copying an access token into the event. */
export function publishAuthSessionChange(
    storage: AuthSignalStorage | null = defaultStorage(),
    createSignal: () => string = createOpaqueSessionSignal,
): void {
    try {
        storage?.setItem(AUTH_SESSION_CHANGE_KEY, createSignal());
    } catch {
        // Cross-tab signaling is best effort in restricted storage contexts.
    }
}

/** Narrow a storage event to Soundspan's opaque auth-generation signal. */
export function isAuthSessionChangeStorageEvent(event: {
    key: string | null;
}): boolean {
    return event.key === AUTH_SESSION_CHANGE_KEY;
}

function isCachedAuthUser(value: unknown): value is CachedAuthUser {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<CachedAuthUser>;
    return (
        typeof candidate.id === "string" &&
        candidate.id.length > 0 &&
        typeof candidate.username === "string" &&
        candidate.username.length > 0 &&
        typeof candidate.role === "string" &&
        candidate.role.length > 0
    );
}

function defaultStorage(): AuthStorage | null {
    if (typeof window === "undefined") return null;
    return window.localStorage;
}

export function readCachedAuthUser(
    storage: AuthStorage | null = defaultStorage(),
): CachedAuthUser | null {
    if (!storage) return null;
    try {
        const raw = storage.getItem(CACHED_AUTH_USER_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return isCachedAuthUser(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function writeCachedAuthUser(
    user: CachedAuthUser,
    storage: AuthStorage | null = defaultStorage(),
): void {
    if (!storage || !isCachedAuthUser(user)) return;
    try {
        storage.setItem(CACHED_AUTH_USER_KEY, JSON.stringify(user));
    } catch {
        // Storage can be unavailable in private/restricted browser contexts.
    }
}

export function clearCachedAuthUser(
    storage: AuthStorage | null = defaultStorage(),
): void {
    try {
        storage?.removeItem(CACHED_AUTH_USER_KEY);
    } catch {
        // Storage can be unavailable in private/restricted browser contexts.
    }
}

/** Local revocation is mandatory even when the server cannot be reached. */
export async function logoutWithMandatoryLocalCleanup(input: {
    remoteLogout: () => Promise<void>;
    clearLocalSession: () => void;
}): Promise<boolean> {
    let remoteLogout: Promise<void>;
    try {
        remoteLogout = input.remoteLogout();
    } catch (error) {
        input.clearLocalSession();
        throw error;
    }

    // Revoke UI, audio, device access, and other tabs immediately. The server
    // request already captured its Authorization header and may finish later.
    input.clearLocalSession();
    await remoteLogout;
    return true;
}

function errorStatus(error: unknown): number | null {
    if (!error || typeof error !== "object" || !("status" in error)) {
        return null;
    }
    const status = Number((error as { status?: unknown }).status);
    return Number.isFinite(status) ? status : null;
}

export function shouldRestoreCachedOfflineSession(input: {
    error: unknown;
    online: boolean;
    hasAccessToken: boolean;
    cachedUser: CachedAuthUser | null;
}): boolean {
    if (!input.hasAccessToken || !input.cachedUser) return false;
    const status = errorStatus(input.error);
    if (status === 401 || status === 403) return false;
    if (input.error instanceof TypeError) return true;
    return (
        !input.online &&
        (status === null || [408, 502, 503, 504].includes(status))
    );
}
