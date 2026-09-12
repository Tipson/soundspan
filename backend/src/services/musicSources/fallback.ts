import { MusicSourceError, type RecordingRequest } from "./types";

interface Dependencies {
    enabled?(): Promise<boolean>;
    primaryTimeoutMs?: number;
    recording(videoId: string): Promise<RecordingRequest | null>;
    resolve(
        userId: string,
        recording: RecordingRequest,
        signal: AbortSignal,
    ): Promise<{ streamPath: string } | null>;
    now?: () => number;
}
interface Input<T> {
    userId: string;
    videoId: string;
    sessionId?: string;
    range?: string;
    signal: AbortSignal;
    original(signal: AbortSignal): Promise<T>;
}
/** Pin one representation per playback attempt so a retry cannot splice different codecs. */
export function createMusicSourceFallback(deps: Dependencies) {
    const bindings = new Map<string, { redirect?: string; expires: number }>();
    const pending = new Set<string>();
    const now = deps.now ?? Date.now;
    return {
        async acquire<T>(
            input: Input<T>,
        ): Promise<{ stream: T } | { redirect: string }> {
            input.signal.throwIfAborted();
            if (
                !input.sessionId ||
                !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
                    input.sessionId,
                )
            )
                return { stream: await input.original(input.signal) };
            const key = `${input.userId}:${input.sessionId}:${input.videoId}`;
            for (const [id, value] of bindings)
                if (value.expires <= now()) bindings.delete(id);
            const bound = bindings.get(key);
            if (bound)
                return bound.redirect
                    ? { redirect: bound.redirect }
                    : { stream: await input.original(input.signal) };
            if (input.range && !/^bytes=0-\d*$/.test(input.range))
                return { stream: await input.original(input.signal) };
            if (bindings.size >= 2000 || pending.size >= 64 || pending.has(key))
                throw new MusicSourceError("busy", 3);
            pending.add(key);
            try {
                const enabled = deps.enabled
                    ? await deps.enabled().catch(() => false)
                    : true;
                const startup = new AbortController();
                const timer = enabled
                    ? setTimeout(
                          () =>
                              startup.abort(
                                  new MusicSourceError("unavailable"),
                              ),
                          deps.primaryTimeoutMs ?? 60_000,
                      ).unref()
                    : undefined;
                const primarySignal = enabled
                    ? AbortSignal.any([input.signal, startup.signal])
                    : input.signal;
                try {
                    let stream: T;
                    try {
                        stream = await input.original(primarySignal);
                    } finally {
                        clearTimeout(timer);
                    }
                    bindings.set(key, { expires: now() + 3_600_000 });
                    return { stream };
                } catch (error) {
                    input.signal.throwIfAborted();
                    if (!enabled) throw error;
                    const status = (
                        error as { response?: { status?: number } } | null
                    )?.response?.status;
                    const networkCode = (error as { code?: string } | null)
                        ?.code;
                    if (
                        !primarySignal.aborted &&
                        ![404, 429, 500, 502, 503, 504].includes(status ?? 0) &&
                        ![
                            "ECONNABORTED",
                            "ECONNREFUSED",
                            "ECONNRESET",
                            "ETIMEDOUT",
                            "ENETUNREACH",
                            "EHOSTUNREACH",
                        ].includes(networkCode ?? "")
                    )
                        throw error;
                    const recording = await deps.recording(input.videoId);
                    input.signal.throwIfAborted();
                    if (!recording) throw error;
                    const playback = await deps.resolve(
                        input.userId,
                        recording,
                        input.signal,
                    );
                    if (!playback) throw error;
                    bindings.set(key, {
                        redirect: playback.streamPath,
                        expires: now() + 3_600_000,
                    });
                    return { redirect: playback.streamPath };
                }
            } finally {
                pending.delete(key);
            }
        },
    };
}
