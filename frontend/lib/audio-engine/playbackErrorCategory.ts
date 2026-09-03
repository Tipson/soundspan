export type PlaybackErrorCategory =
    | "client_abort"
    | "rate_limit"
    | "timeout"
    | "network"
    | "unavailable"
    | "provider_challenge"
    | "unsupported_source"
    | "unknown";

/** Stable low-cardinality category for UI decisions and production metrics. */
export function classifyPlaybackError(error: unknown): PlaybackErrorCategory {
    if (error instanceof DOMException && error.name === "AbortError") {
        return "client_abort";
    }
    const message = (
        error instanceof Error ? error.message : String(error ?? "")
    ).toLowerCase();
    if (message.includes("abort") || message.includes("cancel")) {
        return "client_abort";
    }
    if (message.includes("429") || message.includes("rate limit")) {
        return "rate_limit";
    }
    if (message.includes("timeout") || message.includes("504")) {
        return "timeout";
    }
    if (
        message.includes("network") ||
        message.includes("failed to fetch") ||
        message.includes("connection reset") ||
        message.includes("socket hang up")
    ) {
        return "network";
    }
    if (
        message.includes("404") ||
        message.includes("451") ||
        message.includes("not found") ||
        message.includes("age_restricted")
    ) {
        return "unavailable";
    }
    if (
        message.includes("provider_challenge") ||
        message.includes("failed to extract stream")
    ) {
        return "provider_challenge";
    }
    if (
        message.includes("src_not_supported") ||
        message.includes("decode") ||
        message.includes("unsupported")
    ) {
        return "unsupported_source";
    }
    return "unknown";
}
