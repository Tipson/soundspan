import type { SavedMusicEntity } from "@/lib/api";

type SavedMusicRouteEntity = Pick<
    SavedMusicEntity,
    "entityType" | "source" | "entityId" | "title"
>;

/** Resolve a saved account entity to the route that can browse it again. */
export function getSavedMusicEntityHref(entity: SavedMusicRouteEntity): string {
    if (entity.entityType === "album") {
        if (entity.source === "ytmusic") {
            return `/explore/yt-playlist/${encodeURIComponent(entity.entityId)}?type=album`;
        }
        return `/album/${encodeURIComponent(entity.entityId)}`;
    }

    if (entity.source === "ytmusic") {
        return `/artist/${encodeURIComponent(entity.title)}?provider=ytmusic&channelId=${encodeURIComponent(entity.entityId)}`;
    }
    return `/artist/${encodeURIComponent(entity.entityId)}`;
}
