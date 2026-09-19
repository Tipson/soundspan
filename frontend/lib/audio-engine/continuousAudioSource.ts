import type { AudioEngineSource } from "./types";
import type { ContinuousAudioSource } from "./continuousAudioBuffer";

/** Local read/metadata ports; preparation never requests an external catalog. */
export interface ContinuousSourcePreparation {
    readBlob(url: string, signal: AbortSignal): Promise<Blob>;
    duration(blob: Blob, signal: AbortSignal): Promise<number>;
    supports(mime: string): boolean;
}

/** Conservatively identifies elementary audio and WebM codecs from file bytes. */
export function detectContinuousAudioMime(header: Uint8Array): string | null {
    if (header.length < 4) return null;
    if (header[0] === 73 && header[1] === 68 && header[2] === 51)
        return "audio/mpeg";
    if (header[0] === 255 && (header[1] & 0xf6) === 0xf0) return "audio/aac";
    if (
        header[0] === 255 &&
        (header[1] & 0xe0) === 0xe0 &&
        (header[1] & 0x18) !== 0x08 &&
        (header[1] & 0x06) !== 0 &&
        (header[2] & 0xf0) !== 0xf0 &&
        (header[2] & 0x0c) !== 0x0c
    )
        return "audio/mpeg";
    if (
        header[0] === 0x1a &&
        header[1] === 0x45 &&
        header[2] === 0xdf &&
        header[3] === 0xa3
    ) {
        const text = new TextDecoder().decode(header);
        if (text.includes("webm") && text.includes("A_OPUS"))
            return 'audio/webm;codecs="opus"';
        if (text.includes("webm") && text.includes("A_VORBIS"))
            return 'audio/webm;codecs="vorbis"';
    }
    return null;
}

function probeDuration(blob: Blob, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const audio = document.createElement("audio");
        const url = URL.createObjectURL(blob);
        const cleanup = () => {
            clearTimeout(timer);
            audio.removeEventListener("loadedmetadata", loaded);
            audio.removeEventListener("error", failed);
            signal.removeEventListener("abort", aborted);
            audio.removeAttribute("src");
            audio.load();
            URL.revokeObjectURL(url);
        };
        const loaded = () => {
            const duration = audio.duration;
            cleanup();
            resolve(duration);
        };
        const failed = () => {
            cleanup();
            resolve(0);
        };
        const aborted = () => {
            cleanup();
            reject(signal.reason);
        };
        const timer = setTimeout(failed, 10_000);
        audio.preload = "metadata";
        audio.muted = true;
        audio.addEventListener("loadedmetadata", loaded);
        audio.addEventListener("error", failed);
        signal.addEventListener("abort", aborted, { once: true });
        audio.src = url;
    });
}

const defaultPreparation: ContinuousSourcePreparation = {
    readBlob: async (url, signal) => {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error("Local audio source unavailable");
        return response.blob();
    },
    duration: probeDuration,
    supports: (mime) =>
        typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime),
};

/** Returns null for native fallback; aborts and unreadable local files propagate. */
export async function prepareContinuousAudioSource(
    source: AudioEngineSource,
    signal: AbortSignal,
    ports: ContinuousSourcePreparation = defaultPreparation,
): Promise<ContinuousAudioSource | null> {
    signal.throwIfAborted();
    if (!source.url.startsWith("blob:")) return null;
    const blob = await ports.readBlob(source.url, signal);
    signal.throwIfAborted();
    const header = new Uint8Array(await blob.slice(0, 65_536).arrayBuffer());
    signal.throwIfAborted();
    const mime = detectContinuousAudioMime(header);
    if (!mime || !ports.supports(mime)) return null;
    const durationSec = await ports.duration(blob, signal);
    signal.throwIfAborted();
    if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
    return { id: source.url, url: source.url, blob, mime, durationSec };
}
