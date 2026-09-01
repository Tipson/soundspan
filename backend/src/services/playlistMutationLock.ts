import type { Prisma } from "@prisma/client";

export const PLAYLIST_REORDER_MAX_ITEMS = 1_000;
const PRISMA_INT_MAX = 2_147_483_647;

/** Playlist identity returned after locking an owned row for mutation. */
export type LockedPlaylist = {
    id: string;
    userId: string;
    mixId: string | null;
};

/** Signals that an owned playlist row could not be locked for mutation. */
export class PlaylistMutationLockNotFoundError extends Error {
    constructor() {
        super("Owned playlist disappeared before mutation");
        this.name = "PlaylistMutationLockNotFoundError";
    }
}

/** Locks an owned playlist row so every item mutation uses Playlist-first order. */
export async function takePlaylistLock(
    tx: Prisma.TransactionClient,
    playlistId: string,
    userId: string,
): Promise<LockedPlaylist | null> {
    const playlists = await tx.$queryRaw<LockedPlaylist[]>`
        SELECT p.id, p."userId", p."mixId"
        FROM "Playlist" p
        WHERE p.id = ${playlistId}
          AND p."userId" = ${userId}
        FOR UPDATE OF p
    `;
    return playlists[0] ?? null;
}

/** Requires an owned Playlist row lock before a transaction mutates its items. */
export async function requirePlaylistMutationLock(
    tx: Prisma.TransactionClient,
    playlistId: string,
    userId: string,
): Promise<void> {
    const playlist = await takePlaylistLock(tx, playlistId, userId);
    if (!playlist) {
        throw new PlaylistMutationLockNotFoundError();
    }
}

/** Removes one item after acquiring its owned Playlist row lock. */
export async function removeLockedPlaylistItem(
    tx: Prisma.TransactionClient,
    playlistId: string,
    userId: string,
    itemId: string,
): Promise<void> {
    await requirePlaylistMutationLock(tx, playlistId, userId);
    await tx.playlistItem.delete({ where: { id: itemId } });
    await tx.playlist.update({
        where: { id: playlistId },
        data: { updatedAt: new Date() },
    });
}

/** Reorders a bounded item set after acquiring its owned Playlist row lock. */
export async function reorderLockedPlaylistItems(
    tx: Prisma.TransactionClient,
    playlistId: string,
    userId: string,
    ids: readonly string[],
    byItemId: boolean,
): Promise<void> {
    await requirePlaylistMutationLock(tx, playlistId, userId);
    const itemIds = byItemId
        ? [...ids]
        : await resolveLegacyReorderItemIds(tx, playlistId, ids);
    const maximum = await tx.playlistItem.aggregate({
        where: { playlistId },
        _max: { sort: true },
    });
    const temporaryStart = (maximum._max.sort ?? -1) + 1;
    if (temporaryStart > PRISMA_INT_MAX - itemIds.length) {
        throw new Error("Playlist positions exceed the supported range");
    }

    for (let index = 0; index < itemIds.length; index += 1) {
        await tx.playlistItem.update({
            where: { id: itemIds[index] },
            data: { sort: temporaryStart + index },
        });
    }
    for (let index = 0; index < itemIds.length; index += 1) {
        await tx.playlistItem.update({
            where: { id: itemIds[index] },
            data: { sort: index },
        });
    }
    await tx.playlist.update({
        where: { id: playlistId },
        data: { updatedAt: new Date() },
    });
}

async function resolveLegacyReorderItemIds(
    tx: Prisma.TransactionClient,
    playlistId: string,
    trackIds: readonly string[],
): Promise<string[]> {
    const rows = await tx.playlistItem.findMany({
        where: {
            playlistId,
            trackId: { in: [...new Set(trackIds)] },
        },
        orderBy: [{ sort: "asc" }, { id: "asc" }],
        select: { id: true, trackId: true },
    });
    const rowsByTrackId = new Map<string, string[]>();
    for (const row of rows) {
        if (!row.trackId) continue;
        const itemIds = rowsByTrackId.get(row.trackId) ?? [];
        itemIds.push(row.id);
        rowsByTrackId.set(row.trackId, itemIds);
    }

    return trackIds.map((trackId) => {
        const itemId = rowsByTrackId.get(trackId)?.shift();
        if (!itemId) {
            throw new Error("Playlist reorder references a missing track");
        }
        return itemId;
    });
}
