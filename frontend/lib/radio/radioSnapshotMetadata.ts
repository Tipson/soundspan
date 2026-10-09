import {
    normalizePlaybackRadioOrigin,
    playbackRadioOriginsMatch,
    type PlaybackRadioOrigin,
} from "@soundspan/media-metadata-contract";
import type { PlaybackSnapshotType } from "../playback-state-reconciliation";
import { withPlaybackRadioOrigin } from "./playbackRadioOrigin";

/** Local media fields required for an origin-only snapshot merge. */
export interface RadioSnapshotTrack {
    id: string;
    radioOrigin?: PlaybackRadioOrigin;
    itemType?: string;
}

/** Captured local selection and a fresh, untrusted server queue snapshot. */
export interface RadioSnapshotMetadataInput<
    TTrack extends RadioSnapshotTrack,
    TQueue extends RadioSnapshotTrack,
> {
    localCurrentTrack: TTrack | null;
    localQueue: TQueue[];
    localCurrentIndex: number;
    localPlaybackType: PlaybackSnapshotType;
    localLastSaveAtMs: number;
    localLastServerSyncAtMs: number;
    serverPlaybackType: PlaybackSnapshotType;
    serverMediaId: string | null;
    serverCurrentIndex: unknown;
    serverQueue: unknown;
    serverUpdatedAtMs: number;
}

/** Local rows retaining all source, lineage and display fields after origin reconciliation. */
export interface RadioSnapshotMetadataUpdate<
    TTrack extends RadioSnapshotTrack,
    TQueue extends RadioSnapshotTrack,
> {
    currentTrack: TTrack;
    queue: TQueue[];
}

/**
 * Reconciles only station metadata when a newer snapshot describes the exact same
 * track queue and selected occurrence. Divergent, partial or malformed queues are
 * rejected; absent origin explicitly clears intent without borrowing a duplicate.
 */
export function reconcileRadioSnapshotMetadata<
    TTrack extends RadioSnapshotTrack,
    TQueue extends RadioSnapshotTrack,
>(
    input: RadioSnapshotMetadataInput<TTrack, TQueue>,
): RadioSnapshotMetadataUpdate<TTrack, TQueue> | null {
    const { localCurrentTrack: track, localQueue: queue, serverQueue } = input;
    if (
        input.localPlaybackType !== "track" ||
        input.serverPlaybackType !== "track" ||
        !track?.id ||
        track.id !== input.serverMediaId ||
        !Number.isFinite(input.serverUpdatedAtMs) ||
        input.serverUpdatedAtMs <=
            Math.max(
                0,
                input.localLastSaveAtMs,
                input.localLastServerSyncAtMs,
            ) ||
        !Number.isInteger(input.localCurrentIndex) ||
        input.localCurrentIndex < 0 ||
        input.localCurrentIndex >= queue.length ||
        input.serverCurrentIndex !== input.localCurrentIndex ||
        queue[input.localCurrentIndex]?.id !== track.id ||
        !Array.isArray(serverQueue) ||
        serverQueue.length !== queue.length
    )
        return null;

    const origins: Array<PlaybackRadioOrigin | undefined> = [];
    for (let index = 0; index < queue.length; index += 1) {
        const local = queue[index];
        const server = serverQueue[index];
        if (
            !local?.id ||
            (local.itemType !== undefined && local.itemType !== "track") ||
            !server ||
            typeof server !== "object" ||
            Array.isArray(server) ||
            server.id !== local.id ||
            (server.itemType !== undefined && server.itemType !== "track")
        )
            return null;
        const origin = normalizePlaybackRadioOrigin(server.radioOrigin);
        if (server.radioOrigin != null && !origin) return null;
        origins.push(origin ?? undefined);
    }

    let changed = false;
    const merged = queue.map((row, index) => {
        if (playbackRadioOriginsMatch(row.radioOrigin, origins[index]))
            return row;
        changed = true;
        return withPlaybackRadioOrigin(row, origins[index]);
    });
    const selectedOrigin = origins[input.localCurrentIndex];
    const currentTrack = playbackRadioOriginsMatch(
        track.radioOrigin,
        selectedOrigin,
    )
        ? track
        : withPlaybackRadioOrigin(track, selectedOrigin);
    if (!changed && currentTrack === track) return null;
    return { queue: changed ? merged : queue, currentTrack };
}
