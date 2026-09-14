/** Failure events retained for delivery after a transient connection loss. */
export const PLAYBACK_DIAGNOSTIC_EVENTS = new Set([
    "player.unexpected_stop",
    "player.unexpected_pause",
    "player.rebuffer",
    "player.rebuffer_timeout",
    "player.rebuffer_recovered",
    "player.playback_error",
    "player.recovery_attempt",
    "player.recovery_ready",
    "player.recovery_resumed",
]);

const KEY = "soundspan.playback-diagnostics.v1";
const TTL_MS = 60 * 60 * 1000;
const MAX_ITEMS = 32;
const IDENTIFIER = /^[a-zA-Z0-9_:-]{1,128}$/;
const NUMBER_FIELDS = [
    "currentTimeSec",
    "durationSec",
    "bufferedAheadSec",
    "silenceSinceTimeUpdateMs",
    "debounceElapsedMs",
    "durationMs",
    "resumeAtSec",
    "attemptNumber",
    "loadId",
    "readyState",
    "networkState",
    "mediaErrorCode",
];
const BOOLEAN_FIELDS = [
    "online",
    "enginePlaying",
    "hasPlayIntent",
    "nearTrackEnd",
    "uiIsPlaying",
    "recoverable",
];
const CODE_FIELDS = [
    "trackId",
    "sessionId",
    "sourceType",
    "reason",
    "engineMode",
    "activeEngine",
    "stateMachineState",
    "errorCode",
    "errorCategory",
    "stage",
    "visibility",
    "browser",
    "platform",
];

/** Allow only bounded diagnostic scalars, never source URLs or raw error text. */
export function sanitizePlaybackDiagnosticFields(
    input: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
    const result: Record<string, string | number | boolean | null> = {};
    for (const key of NUMBER_FIELDS) {
        const value = input[key];
        if (value === null) result[key] = null;
        else if (
            typeof value === "number" &&
            Number.isFinite(value) &&
            value >= 0 &&
            value <= 86_400_000
        )
            result[key] = value;
    }
    for (const key of BOOLEAN_FIELDS)
        if (typeof input[key] === "boolean") result[key] = input[key];
    for (const key of CODE_FIELDS)
        if (typeof input[key] === "string" && IDENTIFIER.test(input[key]))
            result[key] = input[key];
    return result;
}

/** Credential-free envelope; the receiving server verifies its owner. */
export interface PlaybackDiagnosticDelivery {
    event: string;
    fields: Record<string, string | number | boolean | null>;
    diagnostic: { id: string; ownerId: string; observedAtMs: number };
}

interface QueueOptions {
    storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
    ownerId(): string | null;
    online(): boolean;
    send(event: PlaybackDiagnosticDelivery, signal: AbortSignal): Promise<void>;
    now?: () => number;
}

/** Bounded, serial, account-scoped outbox. Disposing preserves unsent records. */
export function createPlaybackDiagnosticQueue(options: QueueOptions) {
    const now = options.now ?? Date.now;
    let items: PlaybackDiagnosticDelivery[] = [];
    let running: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active: AbortController | null = null;
    let disposed = false;
    let retryMs = 2000;
    const save = () => {
        try {
            if (items.length)
                options.storage?.setItem(KEY, JSON.stringify(items));
            else options.storage?.removeItem(KEY);
        } catch {
            /* Restricted storage must not interfere with playback. */
        }
    };
    try {
        const raw = options.storage?.getItem(KEY);
        const parsed: unknown =
            raw && raw.length <= 131_072 ? JSON.parse(raw) : [];
        if (Array.isArray(parsed))
            for (const value of parsed.slice(-MAX_ITEMS)) {
                if (!value || typeof value !== "object") continue;
                const entry = value as Partial<PlaybackDiagnosticDelivery>;
                const d = entry.diagnostic;
                if (
                    typeof entry.event !== "string" ||
                    !PLAYBACK_DIAGNOSTIC_EVENTS.has(entry.event) ||
                    !d ||
                    typeof d.id !== "string" ||
                    !IDENTIFIER.test(d.id) ||
                    typeof d.ownerId !== "string" ||
                    !IDENTIFIER.test(d.ownerId) ||
                    !Number.isFinite(d.observedAtMs)
                )
                    continue;
                items.push({
                    event: entry.event,
                    fields: sanitizePlaybackDiagnosticFields(
                        entry.fields && typeof entry.fields === "object"
                            ? entry.fields
                            : {},
                    ),
                    diagnostic: {
                        id: d.id,
                        ownerId: d.ownerId,
                        observedAtMs: d.observedAtMs,
                    },
                });
            }
    } catch {
        /* Malformed or inaccessible storage starts an empty outbox. */
    }
    const cancelTimer = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    const prune = () => {
        const owner = options.ownerId();
        const time = now();
        items = items.filter(
            (e) =>
                e.diagnostic.ownerId === owner &&
                time - e.diagnostic.observedAtMs >= -60_000 &&
                time - e.diagnostic.observedAtMs < TTL_MS,
        );
        save();
    };
    const remove = (id: string) => {
        items = items.filter((e) => e.diagnostic.id !== id);
        save();
    };
    const flush = (): Promise<void> => {
        if (disposed) return Promise.resolve();
        if (running) return running;
        cancelTimer();
        running = Promise.resolve()
            .then(async () => {
                prune();
                for (
                    let count = 0;
                    count < MAX_ITEMS && items.length && !disposed;
                    count++
                ) {
                    prune();
                    const head = items[0];
                    if (!head || !options.online()) return;
                    active = new AbortController();
                    try {
                        await options.send(head, active.signal);
                        remove(head.diagnostic.id);
                        retryMs = 2000;
                    } catch (error) {
                        const status =
                            error &&
                            typeof error === "object" &&
                            "status" in error
                                ? error.status
                                : undefined;
                        if (
                            typeof status === "number" &&
                            status >= 400 &&
                            status < 500 &&
                            status !== 408 &&
                            status !== 429
                        ) {
                            remove(head.diagnostic.id);
                            continue;
                        }
                        if (!disposed) {
                            timer = setTimeout(() => {
                                timer = null;
                                void flush();
                            }, retryMs);
                            retryMs = Math.min(60_000, retryMs * 2);
                        }
                        return;
                    } finally {
                        active = null;
                    }
                }
            })
            .catch(() => {
                /* Diagnostics are best effort, never a playback failure. */
            })
            .finally(() => {
                running = null;
            });
        return running;
    };
    return {
        enqueue(event: string, fields: Record<string, unknown>): void {
            if (disposed || !PLAYBACK_DIAGNOSTIC_EVENTS.has(event)) return;
            const ownerId = options.ownerId();
            if (!ownerId || !IDENTIFIER.test(ownerId)) return;
            prune();
            const id =
                globalThis.crypto?.randomUUID?.() ??
                `event-${now()}-${Math.random().toString(36).slice(2)}`;
            items.push({
                event,
                fields: sanitizePlaybackDiagnosticFields(fields),
                diagnostic: { id, ownerId, observedAtMs: now() },
            });
            items = items.slice(-MAX_ITEMS);
            save();
            void flush();
        },
        flush,
        clear(): void {
            active?.abort();
            cancelTimer();
            items = [];
            save();
        },
        dispose(): void {
            disposed = true;
            active?.abort();
            cancelTimer();
        },
    };
}
