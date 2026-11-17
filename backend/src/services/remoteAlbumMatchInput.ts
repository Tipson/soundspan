import { createHash } from "crypto";

/** Album metadata that may support a conservative canonical suggestion. */
export interface RemoteAlbumMatchInput {
    title: string;
    artist: { name: string; mbid: string | null };
}

/** Binds match results to the exact source metadata and matcher policy version. */
export function albumMatchInputHash(album: RemoteAlbumMatchInput): string {
    return createHash("sha256")
        .update(
            JSON.stringify([
                1,
                album.title,
                album.artist.name,
                album.artist.mbid,
            ]),
        )
        .digest("hex");
}

/** Positive canonical suggestions expire after thirty days. */
export const REMOTE_ALBUM_POSITIVE_MATCH_MS = 30 * 24 * 60 * 60 * 1000;
/** Genuine negative results remain cached for at most one hour. */
export const REMOTE_ALBUM_NEGATIVE_MATCH_MS = 60 * 60 * 1000;
