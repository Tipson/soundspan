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
    "player.engine_pause",
    "player.track_end",
    "player.visibility_change",
]);

const KEY = "soundspan.playback-diagnostics.v2";
const LEGACY_KEY = "soundspan.playback-diagnostics.v1";
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 96;
const MAX_BYTES = 65_536;
const MAX_FAILURES = 6;
const IDENTIFIER = /^[a-zA-Z0-9_:-]{1,128}$/;
const NUMBER_FIELDS = [
    "diagnosticsVersion",
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
    "nativePaused",
    "engineEnded",
    "isLoading",
    "saveData",
    "localSource",
];
const CODE_FIELDS = [
    "frontendBuildId",
    "playbackRunId",
    "sourceKind",
    "connectionType",
    "audioContextState",
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
        else if (input[key] === null) result[key] = null;
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
    storage: Pick<
        Storage,
        "getItem" | "setItem" | "removeItem" | "key" | "length"
    > | null;
    legacyStorage?: Pick<Storage, "getItem" | "removeItem"> | null;
    ownerId(): string | null;
    online(): boolean;
    send(event: PlaybackDiagnosticDelivery, signal: AbortSignal): Promise<void>;
    now?: () => number;
}

/**
 * Bounded account outbox. Each event has its own durable key: another tab's
 * enqueue or late acknowledgement cannot overwrite an unrelated incident.
 * Storage failures fall back to memory without blocking the audio pipeline.
 */
export function createPlaybackDiagnosticQueue(options: QueueOptions) {
    const now = options.now ?? Date.now;
    let owner = options.ownerId();
    let items: PlaybackDiagnosticDelivery[] = [];
    let running: Promise<void> | null = null;
    let flushRequested = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active: AbortController | null = null;
    let disposed = false;
    let generation = 0;
    let failures = 0;
    let retryAtMs = 0;
    // Only failed writes remain here; successful reads must not erase them.
    const memory = new Map<string, PlaybackDiagnosticDelivery>();
    const retired = new Set<string>();
    const ownerKey = () =>
        owner && IDENTIFIER.test(owner) ? `${KEY}:${owner}` : null;
    const eventKey = (id: string) => `${ownerKey()}:event:${id}`;
    const retryKey = () => `${ownerKey()}:retry`;
    const cancelTimer = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    const removeItem = (id: string) => {
        memory.delete(id);
        try {
            options.storage?.removeItem(eventKey(id));
        } catch {
            // Acknowledged/dropped records must not be sent repeatedly merely
            // because the browser temporarily refuses deletion.
            retired.add(id);
            if (retired.size > MAX_ITEMS * 2)
                retired.delete(retired.values().next().value!);
        }
        items = items.filter((item) => item.diagnostic.id !== id);
    };
    const decode = (value: unknown): PlaybackDiagnosticDelivery | null => {
        if (!value || typeof value !== "object") return null;
        const entry = value as Partial<PlaybackDiagnosticDelivery>;
        const d = entry.diagnostic;
        if (
            typeof entry.event !== "string" ||
            !PLAYBACK_DIAGNOSTIC_EVENTS.has(entry.event) ||
            !d ||
            typeof d.id !== "string" ||
            !IDENTIFIER.test(d.id) ||
            d.ownerId !== owner ||
            !Number.isFinite(d.observedAtMs)
        )
            return null;
        const age = now() - d.observedAtMs;
        if (age < -60_000 || age >= TTL_MS) return null;
        return {
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
        };
    };
    const eventKeys = (): string[] => {
        if (!options.storage || !ownerKey()) return [];
        const keys: string[] = [];
        for (let i = 0; i < options.storage.length; i++) {
            const key = options.storage.key(i);
            if (key?.startsWith(`${ownerKey()}:event:`)) keys.push(key);
        }
        return keys;
    };
    const restore = () => {
        const merged = new Map<string, PlaybackDiagnosticDelivery>();
        try {
            for (const key of eventKeys()) {
                let entry: PlaybackDiagnosticDelivery | null = null;
                try {
                    const raw = options.storage!.getItem(key);
                    entry =
                        raw && raw.length <= 8192
                            ? decode(JSON.parse(raw))
                            : null;
                } catch {
                    /* Invalid local records are not uploaded. */
                }
                if (entry && retired.has(entry.diagnostic.id)) continue;
                if (entry && key === eventKey(entry.diagnostic.id))
                    merged.set(entry.diagnostic.id, entry);
                else options.storage?.removeItem(key);
            }
            const rawRetry = ownerKey()
                ? options.storage?.getItem(retryKey())
                : null;
            const retry =
                rawRetry && rawRetry.length <= 512
                    ? JSON.parse(rawRetry)
                    : null;
            if (retry) {
                failures =
                    Number.isInteger(retry.failures) &&
                    retry.failures >= 0 &&
                    retry.failures <= MAX_FAILURES
                        ? retry.failures
                        : 0;
                retryAtMs =
                    Number.isFinite(retry.retryAtMs) &&
                    retry.retryAtMs <= now() + 60_000
                        ? Math.max(0, retry.retryAtMs)
                        : 0;
            }
        } catch {
            // A storage read denied after successful writes keeps the last view.
            for (const item of items) merged.set(item.diagnostic.id, item);
        }
        for (const [id, item] of memory) merged.set(id, item);
        items = [...merged.values()]
            .filter((item) => {
                if (decode(item)) return true;
                removeItem(item.diagnostic.id);
                return false;
            })
            .sort(
                (a, b) => a.diagnostic.observedAtMs - b.diagnostic.observedAtMs,
            );
        let bytes = items.reduce(
            (total, item) => total + JSON.stringify(item).length,
            512,
        );
        while (
            items.length > MAX_ITEMS ||
            (bytes > MAX_BYTES && items.length)
        ) {
            const first = items[0];
            bytes -= JSON.stringify(first).length;
            removeItem(first.diagnostic.id);
        }
    };
    const saveRetry = () => {
        try {
            if (!ownerKey()) return;
            if (items.length && (failures || retryAtMs))
                options.storage?.setItem(
                    retryKey(),
                    JSON.stringify({ failures, retryAtMs }),
                );
            else options.storage?.removeItem(retryKey());
        } catch {
            /* Retry bounds remain enforced in memory. */
        }
    };
    const append = (item: PlaybackDiagnosticDelivery) => {
        memory.set(item.diagnostic.id, item);
        try {
            if (options.storage) {
                options.storage.setItem(
                    eventKey(item.diagnostic.id),
                    JSON.stringify(item),
                );
                memory.delete(item.diagnostic.id);
            }
        } catch {
            /* Memory-only when the browser denies durable storage. */
        }
        restore();
    };
    const clearOwner = () => {
        memory.clear();
        retired.clear();
        items = [];
        try {
            for (const key of eventKeys()) options.storage?.removeItem(key);
            if (ownerKey()) {
                options.storage?.removeItem(retryKey());
                options.storage?.removeItem(ownerKey()!);
            }
        } catch {
            /* Runtime is still retired when storage is unavailable. */
        }
        failures = 0;
        retryAtMs = 0;
    };
    const prune = () => {
        if (options.ownerId() !== owner) {
            generation++;
            active?.abort();
            cancelTimer();
            clearOwner();
            owner = options.ownerId();
        }
        restore();
    };
    restore();
    // Migrate the former per-tab v1 queue and any intermediate v2 envelope.
    for (const [storage, key] of [
        [options.legacyStorage, LEGACY_KEY],
        [options.storage, ownerKey()],
    ] as const) {
        if (!storage || !key) continue;
        try {
            const raw = storage.getItem(key);
            const value = raw && raw.length <= 131_072 ? JSON.parse(raw) : null;
            const legacy = Array.isArray(value) ? value : value?.items;
            if (Array.isArray(legacy))
                for (const candidate of legacy.slice(-MAX_ITEMS)) {
                    const item = decode(candidate);
                    if (
                        item &&
                        !items.some(
                            (existing) =>
                                existing.diagnostic.id === item.diagnostic.id,
                        )
                    )
                        append(item);
                }
            storage.removeItem(key);
        } catch {
            /* Migration is optional in restricted storage. */
        }
    }
    const flush = (): Promise<void> => {
        if (disposed) return Promise.resolve();
        if (running) {
            flushRequested = true;
            return running;
        }
        running = Promise.resolve()
            .then(async () => {
                prune();
                const capturedGeneration = generation;
                for (let count = 0; count < MAX_ITEMS && !disposed; count++) {
                    prune();
                    const head = items[0];
                    if (
                        !head ||
                        !options.online() ||
                        capturedGeneration !== generation ||
                        failures >= MAX_FAILURES ||
                        now() < retryAtMs
                    )
                        return;
                    cancelTimer();
                    active = new AbortController();
                    try {
                        await options.send(head, active.signal);
                        if (
                            disposed ||
                            capturedGeneration !== generation ||
                            options.ownerId() !== owner
                        )
                            return;
                        removeItem(head.diagnostic.id);
                        failures = 0;
                        retryAtMs = 0;
                        saveRetry();
                    } catch (error) {
                        if (
                            disposed ||
                            capturedGeneration !== generation ||
                            options.ownerId() !== owner
                        )
                            return;
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
                            removeItem(head.diagnostic.id);
                            failures = 0;
                            retryAtMs = 0;
                            saveRetry();
                            continue;
                        }
                        restore();
                        failures++;
                        const retryMs = Math.min(
                            60_000,
                            2000 * 2 ** (failures - 1),
                        );
                        retryAtMs = now() + retryMs;
                        saveRetry();
                        if (failures < MAX_FAILURES && options.online())
                            timer = setTimeout(() => {
                                timer = null;
                                void flush();
                            }, retryMs);
                        return;
                    } finally {
                        active = null;
                    }
                }
            })
            .catch(() => {
                /* Diagnostics never become a playback failure. */
            })
            .finally(() => {
                running = null;
                if (flushRequested) {
                    flushRequested = false;
                    void flush();
                }
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
            append({
                event,
                fields: sanitizePlaybackDiagnosticFields(fields),
                diagnostic: { id, ownerId, observedAtMs: now() },
            });
            void flush();
        },
        flush,
        /** A real lifecycle/connectivity wake begins a new finite retry burst. */
        wake(): Promise<void> {
            if (disposed) return Promise.resolve();
            prune();
            failures = 0;
            retryAtMs = 0;
            cancelTimer();
            saveRetry();
            return flush();
        },
        clear(): void {
            generation++;
            active?.abort();
            cancelTimer();
            clearOwner();
        },
        dispose(): void {
            generation++;
            disposed = true;
            active?.abort();
            cancelTimer();
        },
    };
}
