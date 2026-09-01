const STORAGE_KEY = "soundspan.recommendation-session";

let fallbackSessionId: string | null = null;

function createSessionId(): string {
    if (typeof globalThis.crypto?.randomUUID === "function") {
        return globalThis.crypto.randomUUID();
    }
    if (typeof globalThis.crypto?.getRandomValues !== "function") {
        throw new Error(
            "Web Crypto is required to create a recommendation session",
        );
    }
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return [
        hex.slice(0, 4).join(""),
        hex.slice(4, 6).join(""),
        hex.slice(6, 8).join(""),
        hex.slice(8, 10).join(""),
        hex.slice(10, 16).join(""),
    ].join("-");
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
