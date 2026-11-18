import type { PlaylistDetailResponse } from "@/lib/api";
import type { Track } from "@/lib/audio-state-context";
import type {
    RecommendationQueueAdmissionResult,
    FiniteQueueAdmissionReference,
} from "@/lib/audio/recommendationQueueAdmission";
import type { SmartShuffleOptions } from "@/lib/audio/finiteSmartShuffle";
import {
    buildSmartShuffleQueue,
    SMART_SHUFFLE_MAX_OWN,
    SMART_SHUFFLE_POOL_LIMIT,
    SMART_SHUFFLE_MAX_QUEUE,
} from "@/lib/audio/finiteSmartShuffle";
import { parseQueueAdmissionResponse } from "@/lib/audio/recommendationQueueAdmission";
import { recommendationAdmissionReference } from "@/lib/audio/recommendationQueueAdmissionPolicy";
import { isPlayableTrackItem, toAudioTrack } from "@/lib/playlistItemPlayback";
import { normalizeRadioTracks } from "@/lib/radio/loadTrackRadio";
import { comparePlaylistEntries } from "./playlistPagination";
import {
    hasNativeMusicSourceIdentity,
    readMusicSourcePlaybackTrack,
} from "@/lib/audio/musicSourcePlayback";

export interface PrepareSmartShuffleOptions extends SmartShuffleOptions {
    isCurrent: () => boolean;
    signal?: AbortSignal;
    online?: boolean;
    cachedSnapshot?: PlaylistDetailResponse;
    loadSnapshot: () => Promise<PlaylistDetailResponse>;
    loadPool: () => Promise<unknown[]>;
    admit: (
        refs: readonly FiniteQueueAdmissionReference[],
        signal?: AbortSignal,
    ) => Promise<RecommendationQueueAdmissionResult | { status: "superseded" }>;
}
export interface PreparedSmartShuffle {
    status: "ready" | "invalid-snapshot" | "superseded" | "queue-limit";
    tracks: Track[];
}
/** Capture one complete owner playlist, then admit a bounded read-only pool.
 * Never truncate original occurrences or return a partial queue on cancellation.
 */
export async function prepareSmartShuffle(
    options: PrepareSmartShuffleOptions,
): Promise<PreparedSmartShuffle> {
    const current = () => !options.signal?.aborted && options.isCurrent();
    const cancelled = (): PreparedSmartShuffle => ({
        status: "superseded",
        tracks: [],
    });
    if (!current()) return cancelled();
    let snapshot: PlaylistDetailResponse | undefined;
    try {
        snapshot =
            options.online === false
                ? options.cachedSnapshot
                : await options.loadSnapshot();
    } catch {
        return current()
            ? { status: "invalid-snapshot", tracks: [] }
            : cancelled();
    }
    if (!current()) return cancelled();
    if (
        !snapshot ||
        snapshot.id !== options.playlistId ||
        snapshot.isOwner !== true ||
        snapshot.truncated === true ||
        snapshot.pagination?.hasMore ||
        !Array.isArray(snapshot.items) ||
        !Array.isArray(snapshot.pendingTracks)
    )
        return { status: "invalid-snapshot", tracks: [] };
    const count = snapshot.items.length + snapshot.pendingTracks.length;
    const total =
        snapshot.totalItemCount ??
        (snapshot.trackCount === undefined
            ? undefined
            : snapshot.trackCount + snapshot.pendingCount);
    if (
        count > SMART_SHUFFLE_MAX_OWN ||
        total !== count ||
        new Set(snapshot.items.map((item) => item.id)).size !==
            snapshot.items.length ||
        snapshot.items.some((item) => !Number.isSafeInteger(item.sort))
    )
        return { status: "invalid-snapshot", tracks: [] };
    let own: Track[];
    try {
        own = [...snapshot.items]
            .sort(comparePlaylistEntries)
            .filter(isPlayableTrackItem)
            .map((item) => {
                if (!hasNativeMusicSourceIdentity(item.track))
                    return toAudioTrack(item);
                const native = readMusicSourcePlaybackTrack(item.track);
                if (!native)
                    throw new Error("Invalid exact playlist recording");
                return { ...native, playlistItemId: item.id };
            });
    } catch {
        return { status: "invalid-snapshot", tracks: [] };
    }
    if (!own.length) return { status: "invalid-snapshot", tracks: [] };
    if (own.length >= SMART_SHUFFLE_MAX_QUEUE)
        return { status: "queue-limit", tracks: [] };
    const result = (pool: Track[]): PreparedSmartShuffle => {
        try {
            return {
                status: "ready",
                tracks: buildSmartShuffleQueue(own, pool, options),
            };
        } catch {
            return { status: "invalid-snapshot", tracks: [] };
        }
    };
    if (options.online === false) return result([]);
    try {
        const raw = await options.loadPool();
        if (!current()) return cancelled();
        if (!Array.isArray(raw) || raw.length > SMART_SHUFFLE_POOL_LIMIT)
            return result([]);
        const candidates = normalizeRadioTracks(raw, own).flatMap((track) => {
            const reference = recommendationAdmissionReference(track);
            return reference ? [{ track, reference }] : [];
        });
        if (!candidates.length) return result([]);
        const references = candidates.map((candidate) => candidate.reference);
        const admission = await options.admit(references, options.signal);
        if (!current() || admission.status === "superseded") return cancelled();
        if (admission.status !== "ready") return result([]);
        const response = parseQueueAdmissionResponse(
            admission.response,
            references,
        );
        if (!response) return result([]);
        return result(
            candidates.flatMap((candidate, index) =>
                response.decisions[index].state === "allowed"
                    ? [candidate.track]
                    : [],
            ),
        );
    } catch {
        return current() ? result([]) : cancelled();
    }
}
