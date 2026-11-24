import { MusicSourceError, type RecordingRequest } from "./types";

interface Dependencies {
    enabled?(): Promise<boolean>;
    primaryTimeoutMs?: number;
    fallbackDelayMs?: number;
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
            // Web uses UUIDv4; Android uses 24 random bytes encoded as base64url.
            if (
                !input.sessionId ||
                !/^(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|[A-Za-z0-9_-]{32})$/i.test(
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
                const alternate = new AbortController();
                const alternateSignal = AbortSignal.any([
                    input.signal,
                    alternate.signal,
                ]);
                type Outcome =
                    | { kind: "stream"; stream: T }
                    | { kind: "error"; error: unknown }
                    | {
                          kind: "alternate";
                          playback: { streamPath: string } | null;
                      };
                let completeAlternate!: (outcome: Outcome) => void;
                const alternateResult = new Promise<Outcome>((finish) => {
                    completeAlternate = finish;
                });
                let alternateStarted = false;
                const startAlternate = () => {
                    if (alternateStarted || alternateSignal.aborted) return;
                    alternateStarted = true;
                    void Promise.resolve()
                        .then(async () => {
                            alternateSignal.throwIfAborted();
                            const recording = await deps.recording(
                                input.videoId,
                            );
                            alternateSignal.throwIfAborted();
                            if (!recording) return null;
                            const playback = await deps.resolve(
                                input.userId,
                                recording,
                                alternateSignal,
                            );
                            alternateSignal.throwIfAborted();
                            return playback;
                        })
                        .then(
                            (playback) =>
                                completeAlternate({
                                    kind: "alternate",
                                    playback,
                                }),
                            () =>
                                completeAlternate({
                                    kind: "alternate",
                                    playback: null,
                                }),
                        );
                };
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
                const fallbackTimer = enabled
                    ? setTimeout(
                          startAlternate,
                          deps.fallbackDelayMs ?? 6_000,
                      ).unref()
                    : undefined;
                let cancel = () => {};
                const cancelled = new Promise<never>((_, reject) => {
                    cancel = () => reject(input.signal.reason);
                    input.signal.addEventListener("abort", cancel, {
                        once: true,
                    });
                    if (input.signal.aborted) cancel();
                });
                const primary = Promise.resolve()
                    .then(() => {
                        primarySignal.throwIfAborted();
                        return input.original(primarySignal);
                    })
                    .then<Outcome, Outcome>(
                        (stream) => ({ kind: "stream", stream }),
                        (error: unknown) => ({ kind: "error", error }),
                    );
                let primaryWon = false;
                try {
                    let waiting = [primary, alternateResult, cancelled];
                    let primaryFailure: { error: unknown } | undefined;
                    let result: { stream: T } | { redirect: string };
                    for (;;) {
                        const outcome = await Promise.race(waiting);
                        if (outcome.kind === "stream") {
                            primaryWon = true;
                            result = { stream: outcome.stream };
                            break;
                        }
                        if (outcome.kind === "alternate") {
                            if (outcome.playback) {
                                result = {
                                    redirect: outcome.playback.streamPath,
                                };
                                break;
                            }
                            if (primaryFailure) throw primaryFailure.error;
                            waiting = [primary, cancelled];
                            continue;
                        }
                        clearTimeout(timer);
                        const error = outcome.error;
                        if (!enabled) throw error;
                        const status = (
                            error as { response?: { status?: number } } | null
                        )?.response?.status;
                        const networkCode = (error as { code?: string } | null)
                            ?.code;
                        if (
                            !primarySignal.aborted &&
                            ![404, 429, 500, 502, 503, 504].includes(
                                status ?? 0,
                            ) &&
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
                        primaryFailure = outcome;
                        startAlternate();
                        waiting = [alternateResult, cancelled];
                    }
                    input.signal.throwIfAborted();
                    bindings.set(key, {
                        ...("redirect" in result
                            ? { redirect: result.redirect }
                            : {}),
                        expires: now() + 3_600_000,
                    });
                    return result;
                } finally {
                    clearTimeout(timer);
                    clearTimeout(fallbackTimer);
                    input.signal.removeEventListener("abort", cancel);
                    alternate.abort();
                    if (!primaryWon) startup.abort();
                }
            } finally {
                pending.delete(key);
            }
        },
    };
}
