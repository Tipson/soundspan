import { isValidMbid } from "../utils/musicIds";
import {
    albumMatchInputHash,
    REMOTE_ALBUM_POSITIVE_MATCH_MS,
    type RemoteAlbumMatchInput,
} from "./remoteAlbumMatchInput";

interface MatchedAlbum extends RemoteAlbumMatchInput {
    location: string;
    rgMbid: string;
    matchedRgMbid?: string | null;
    rgMbidCheckedAt?: Date | null;
    rgMbidMatchInputHash?: string | null;
}

/** Project only a current suggestion after the caller's ordinary album ACL. */
export function currentRemoteAlbumMatch(
    album: MatchedAlbum,
    now = new Date(),
): string | null {
    if (
        album.location !== "REMOTE" ||
        !album.rgMbid.startsWith("remote:") ||
        !isValidMbid(album.matchedRgMbid) ||
        !album.rgMbidCheckedAt
    )
        return null;
    const age = now.getTime() - album.rgMbidCheckedAt.getTime();
    if (
        !Number.isFinite(age) ||
        age < 0 ||
        age >= REMOTE_ALBUM_POSITIVE_MATCH_MS ||
        album.rgMbidMatchInputHash !== albumMatchInputHash(album)
    )
        return null;
    return album.matchedRgMbid;
}
