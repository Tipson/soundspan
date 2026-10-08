/** Original musical intent of a radio queue, independent of the playing song. */
export type PlaybackRadioOrigin =
    | { kind: "track"; source: "youtube" | "library"; id: string }
    | { kind: "artist"; source: "library"; id: string }
    | { kind: "artist"; source: "discovery"; name: string };

/** Keeps only a bounded supported radio identity from an untrusted queue item. */
export function normalizePlaybackRadioOrigin(
    value: unknown,
): PlaybackRadioOrigin | null {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const candidate = value as Record<string, unknown>;
    if (candidate.kind === "artist" && candidate.source === "discovery") {
        if (typeof candidate.name !== "string") return null;
        const name = candidate.name.trim();
        if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/u.test(name))
            return null;
        return { kind: "artist", source: "discovery", name };
    }
    if (
        (candidate.kind !== "track" && candidate.kind !== "artist") ||
        (candidate.source !== "library" &&
            !(candidate.kind === "track" && candidate.source === "youtube")) ||
        typeof candidate.id !== "string"
    )
        return null;
    const id = candidate.id.trim();
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) return null;
    if (candidate.source === "youtube" && id.length !== 11) return null;
    if (candidate.kind === "artist")
        return { kind: "artist", source: "library", id };
    return {
        kind: "track",
        source: candidate.source as "youtube" | "library",
        id,
    };
}

/** Compares normalized radio intent without depending on object or field order. */
export function playbackRadioOriginsMatch(
    left: unknown,
    right: unknown,
): boolean {
    return (
        JSON.stringify(normalizePlaybackRadioOrigin(left)) ===
        JSON.stringify(normalizePlaybackRadioOrigin(right))
    );
}
