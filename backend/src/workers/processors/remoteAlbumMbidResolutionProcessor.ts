import { resolveRemoteAlbumMbids } from "../../services/remoteAlbumMbidResolution";

/** Existing maintenance lane resolves at most one bounded page per claimed job. */
export async function processRemoteAlbumMbidResolution(): Promise<void> {
    await resolveRemoteAlbumMbids({ batchSize: 25 });
}
