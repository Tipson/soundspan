import { AUTH_SESSION_CHANGE_KEY } from "./auth-offline-session";
import { BRAND_SLUG } from "./brand";

/** Private logical-login metadata; it contains no credential or account identity. */
export const PLAY_CREATE_LOGIN_FENCE_KEY = `${BRAND_SLUG}_play_create_login_fence_v1`;
type FenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
interface LoginFence {
    version: 1;
    nonce: string;
    publication: string | null;
}
const noncePattern = /^[A-Za-z0-9_-]{32}$/;
const publicationPattern = /^[A-Za-z0-9_-]{1,128}$/;

function defaultStorage(): FenceStorage | null {
    try {
        return typeof window === "undefined" ? null : localStorage;
    } catch {
        return null;
    }
}

function publication(storage: FenceStorage): string | null | undefined {
    const value = storage.getItem(AUTH_SESSION_CHANGE_KEY);
    return value === null || publicationPattern.test(value) ? value : undefined;
}

function parseFence(raw: string | null): LoginFence | null {
    if (raw === null || raw.length > 300) return null;
    try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value))
            return null;
        const row = value as Record<string, unknown>;
        if (
            Object.keys(row).length !== 3 ||
            row.version !== 1 ||
            typeof row.nonce !== "string" ||
            !noncePattern.test(row.nonce) ||
            !(
                row.publication === null ||
                (typeof row.publication === "string" &&
                    publicationPattern.test(row.publication))
            )
        )
            return null;
        return { version: 1, nonce: row.nonce, publication: row.publication };
    } catch {
        return null;
    }
}

/** Cryptographically random fencing value, independent of token and device clocks. */
export function createPlayCreateLoginNonce(): string | null {
    try {
        const bytes = crypto.getRandomValues(new Uint8Array(24));
        return btoa(String.fromCharCode(...bytes))
            .replace(/\+/g, "-")
            .replace(/\//g, "_");
    } catch {
        return null;
    }
}

/** Read only; a nonce is never proof of online identity or a delivery grant. */
export function readPlayCreateLoginFence(
    storage: FenceStorage | null = defaultStorage(),
): string | null {
    if (!storage) return null;
    try {
        const row = parseFence(storage.getItem(PLAY_CREATE_LOGIN_FENCE_KEY));
        const signal = publication(storage);
        return row && signal !== undefined && row.publication === signal
            ? row.nonce
            : null;
    } catch {
        return null;
    }
}

/** Prepare replacement metadata before publishing the same opaque auth signal. */
export function preparePlayCreateLoginFence(
    nonce: string,
    storage: FenceStorage | null = defaultStorage(),
): boolean {
    if (!storage || !noncePattern.test(nonce)) return false;
    try {
        const value = JSON.stringify({ version: 1, nonce, publication: nonce });
        storage.setItem(PLAY_CREATE_LOGIN_FENCE_KEY, value);
        return storage.getItem(PLAY_CREATE_LOGIN_FENCE_KEY) === value;
    } catch {
        return false;
    }
}

/** Restore one login across reload, or provision an older session without an auth reset. */
export function restorePlayCreateLoginFence(
    storage: FenceStorage | null = defaultStorage(),
    createNonce: () => string | null = createPlayCreateLoginNonce,
): string | null {
    if (!storage) return null;
    try {
        const raw = storage.getItem(PLAY_CREATE_LOGIN_FENCE_KEY);
        const row = parseFence(raw);
        // Unknown/corrupt formats must not be silently overwritten by an old client.
        if (raw !== null && !row) return null;
        const signal = publication(storage);
        if (signal === undefined) return null;
        if (row?.publication === signal) return row.nonce;
        const nonce = createNonce();
        if (nonce === null || !noncePattern.test(nonce)) return null;
        storage.setItem(
            PLAY_CREATE_LOGIN_FENCE_KEY,
            JSON.stringify({ version: 1, nonce, publication: signal }),
        );
        return readPlayCreateLoginFence(storage) === nonce ? nonce : null;
    } catch {
        return null;
    }
}

/** Late cleanup is conditional: it cannot erase the replacement login's fence. */
export function retirePlayCreateLoginFence(
    expectedNonce: string | null,
    storage: FenceStorage | null = defaultStorage(),
): void {
    if (!storage || expectedNonce === null) return;
    try {
        if (
            parseFence(storage.getItem(PLAY_CREATE_LOGIN_FENCE_KEY))?.nonce ===
            expectedNonce
        )
            storage.removeItem(PLAY_CREATE_LOGIN_FENCE_KEY);
    } catch {
        // The auth publication also invalidates retained metadata if physical removal fails.
    }
}
