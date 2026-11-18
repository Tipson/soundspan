import type { Track } from "../audio-state-context";
import { resolvePreferenceTrackId } from "../trackRef";
import {
    RecommendationQueueFeedback,
    type RecommendationFeedbackQueue,
} from "./recommendationQueueFeedback";

/** Client-only finite playlist occurrence lineage; never a provider identity. */
export interface SmartShuffleLineage {
    v: 1;
    sessionId: string;
    playlistId: string;
    seed: number;
    snapshotId: string;
    kind: "own" | "injected";
    occurrenceId: string;
    cursor: number;
    enabled: boolean;
}
export interface SmartShuffleOptions {
    playlistId: string;
    sessionId: string;
    seed: number;
}
export const SMART_SHUFFLE_MAX_OWN = 5000;
export const SMART_SHUFFLE_POOL_LIMIT = 50;
/** Existing playback-state persistence keeps at most 100 occurrences. */
export const SMART_SHUFFLE_MAX_QUEUE = 100;

function identifier(value: unknown, max = 128): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= max &&
        /^[A-Za-z0-9_:-]+$/.test(value)
    );
}

/** Stable snapshot label, never authorization or canonical matching evidence. */
function hash(value: string): number {
    let result = 2166136261;
    for (let i = 0; i < value.length; i++)
        result = Math.imul(result ^ value.charCodeAt(i), 16777619);
    return result >>> 0;
}

/** Shuffle only the finite recommendation pool; original playlist order stays exact. */
export function buildSmartShuffleQueue(
    own: readonly Track[],
    pool: readonly Track[],
    options: SmartShuffleOptions,
): Track[] {
    if (
        !own.length ||
        own.length > SMART_SHUFFLE_MAX_OWN ||
        own.length >= SMART_SHUFFLE_MAX_QUEUE ||
        pool.length > SMART_SHUFFLE_POOL_LIMIT ||
        !identifier(options.playlistId) ||
        !identifier(options.sessionId, 96) ||
        !Number.isInteger(options.seed) ||
        options.seed < 0 ||
        options.seed > 0xffffffff ||
        own.some((t) => !identifier(t.playlistItemId)) ||
        new Set(own.map((t) => t.playlistItemId)).size !== own.length
    ) {
        throw new Error("Invalid finite playlist snapshot");
    }
    const snapshotId = hash(
        JSON.stringify(
            own.map((t) => [t.playlistItemId, resolvePreferenceTrackId(t)]),
        ),
    )
        .toString(16)
        .padStart(8, "0");
    const seen = new Set(own.map(resolvePreferenceTrackId));
    const candidates = pool.filter((track) => {
        const key = resolvePreferenceTrackId(track);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    let state = options.seed;
    for (let i = candidates.length - 1; i > 0; i--) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const j = state % (i + 1);
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const queue: Track[] = [];
    let cursor = 0;
    const capacity = SMART_SHUFFLE_MAX_QUEUE - own.length;
    const lineage = (
        kind: SmartShuffleLineage["kind"],
        occurrenceId: string,
    ): SmartShuffleLineage => ({
        v: 1,
        sessionId: options.sessionId,
        playlistId: options.playlistId,
        seed: options.seed,
        snapshotId,
        kind,
        occurrenceId,
        cursor: 0,
        enabled: true,
    });
    own.forEach((track, index) => {
        queue.push({
            ...track,
            recommendationGenerationId: undefined,
            recommendationSessionId: undefined,
            recommendationQueueMode: undefined,
            smartShuffle: lineage("own", `own:${track.playlistItemId}`),
        });
        if (
            ((index + 1) % 3 === 0 ||
                (own.length < 3 && index === own.length - 1)) &&
            cursor < candidates.length &&
            cursor < capacity
        ) {
            queue.push({
                ...candidates[cursor],
                playlistItemId: undefined,
                trackYtMusicId: undefined,
                recommendationSessionId: `smart-shuffle:${options.sessionId}`,
                recommendationQueueMode: "finite",
                smartShuffle: lineage(
                    "injected",
                    `injected:${options.sessionId}:${cursor}`,
                ),
            });
            cursor++;
        }
    });
    return queue.map((track) => ({
        ...track,
        smartShuffle: { ...track.smartShuffle!, cursor, enabled: cursor > 0 },
    }));
}

/** Disable only future inserted occurrences. Current audio and history are retained. */
export function disableSmartShuffle<T extends object>(
    queue: T[],
    currentIndex: number,
    sessionId: string,
): T[] {
    if (
        !Number.isInteger(currentIndex) ||
        currentIndex < 0 ||
        currentIndex >= queue.length
    )
        return queue;
    let changed = false;
    const next = queue.flatMap((item, index) => {
        const metadata = readSmartShuffleLineage(
            (item as { smartShuffle?: unknown }).smartShuffle,
        );
        if (!metadata || metadata.sessionId !== sessionId) return [item];
        changed = true;
        if (index > currentIndex && metadata.kind === "injected") return [];
        return [{ ...item, smartShuffle: { ...metadata, enabled: false } }];
    });
    return changed ? next : queue;
}

/** Closed local checkpoint metadata; unknown versions cannot enable the mode. */
export function readSmartShuffleLineage(
    value: unknown,
): SmartShuffleLineage | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const row = value as Record<string, unknown>;
    if (
        row.v !== 1 ||
        !identifier(row.sessionId, 96) ||
        !identifier(row.playlistId) ||
        typeof row.snapshotId !== "string" ||
        !/^[a-f0-9]{8}$/.test(row.snapshotId) ||
        !Number.isInteger(row.seed) ||
        (row.seed as number) < 0 ||
        (row.seed as number) > 0xffffffff ||
        (row.kind !== "own" && row.kind !== "injected") ||
        !identifier(row.occurrenceId, 256) ||
        !Number.isInteger(row.cursor) ||
        (row.cursor as number) < 0 ||
        (row.cursor as number) > 50 ||
        typeof row.enabled !== "boolean"
    )
        return undefined;
    return {
        v: 1,
        sessionId: row.sessionId,
        playlistId: row.playlistId,
        seed: row.seed as number,
        snapshotId: row.snapshotId,
        kind: row.kind,
        occurrenceId: row.occurrenceId,
        cursor: row.cursor as number,
        enabled: row.enabled,
    };
}

/** Reuse the existing future-pruning/remap contract, including shuffled history. */
export function disableSmartShufflePlayback(
    input: RecommendationFeedbackQueue,
    sessionId: string,
): RecommendationFeedbackQueue {
    const pruned = new RecommendationQueueFeedback().pruneFuture(
        input,
        (item) => {
            const meta = readSmartShuffleLineage((item as Track).smartShuffle);
            return meta?.sessionId !== sessionId || meta.kind !== "injected";
        },
    );
    return {
        ...pruned,
        queue: disableSmartShuffle(
            pruned.queue,
            pruned.queue.length - 1,
            sessionId,
        ),
    };
}
