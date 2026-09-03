const STORAGE_KEY = "soundspan.recommendation-session";

/** Coarse, non-identifying browser context attached to recommendation requests. */
export interface RecommendationClientContext {
    localHour: number;
    timezoneOffsetMinutes: number;
    deviceClass: "mobile" | "tablet" | "desktop" | "tv";
}

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

/** Coarse, non-identifying listening context used to learn session preferences. */
export function getRecommendationClientContext(): RecommendationClientContext | null {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
        return null;
    }
    const userAgent = navigator.userAgent.toLocaleLowerCase();
    const deviceClass = /smart-tv|smarttv|hbbtv|appletv|googletv/.test(
        userAgent,
    )
        ? "tv"
        : window.matchMedia("(max-width: 767px)").matches
          ? "mobile"
          : window.matchMedia("(max-width: 1024px)").matches
            ? "tablet"
            : "desktop";
    const now = new Date();
    return {
        localHour: now.getHours(),
        timezoneOffsetMinutes: -now.getTimezoneOffset(),
        deviceClass,
    };
}

/** Appends the bounded client context shared by Home and queue continuation. */
export function appendRecommendationClientContext(
    params: URLSearchParams,
    context: RecommendationClientContext | null,
): void {
    if (!context) return;
    params.set("localHour", String(context.localHour));
    params.set("timezoneOffsetMinutes", String(context.timezoneOffsetMinutes));
    params.set("deviceClass", context.deviceClass);
}
