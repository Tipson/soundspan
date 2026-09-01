const STORAGE_KEY = "soundspan.recommendation-session";

let fallbackSessionId: string | null = null;

function createSessionId(): string {
    if (typeof globalThis.crypto?.randomUUID === "function") {
        return globalThis.crypto.randomUUID();
    }
    return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** One identifier per browser tab, shared by all recommendation surfaces. */
export function getRecommendationSessionId(): string {
    if (typeof window === "undefined") {
        fallbackSessionId ??= createSessionId();
        return fallbackSessionId;
    }
    const stored = window.sessionStorage.getItem(STORAGE_KEY)?.trim();
    if (stored) return stored;
    const sessionId = createSessionId();
    window.sessionStorage.setItem(STORAGE_KEY, sessionId);
    return sessionId;
}
