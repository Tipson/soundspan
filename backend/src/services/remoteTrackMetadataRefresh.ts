/**
 * RemoteTrackMetadataRefreshService — Re-fetches metadata for remote provider rows
 * that still have placeholder values ("Unknown", empty strings) from before the
 * metadata preservation fix.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { ytMusicService } from "./youtubeMusic";

const log = logger.child("RemoteTrackMetadataRefresh");

const DEFAULT_BATCH_SIZE = 100;
const TITLE_PLACEHOLDERS = [
    "Unknown",
    "unknown",
    "",
    "Unknown Track",
    "unknown track",
];
const ARTIST_PLACEHOLDERS = [
    "Unknown",
    "unknown",
    "",
    "Unknown Artist",
    "unknown artist",
];
const ALBUM_PLACEHOLDERS = [
    "Unknown",
    "unknown",
    "",
    "Unknown Album",
    "unknown album",
    "Single",
    "single",
];
const REAL_VALUE_PLACEHOLDERS = new Set([
    "unknown",
    "",
    "single",
    "unknown album",
    "unknown artist",
    "unknown track",
]);

/**
 * Returns true if the value is a real (non-placeholder) string.
 */
function isRealValue(value: string | undefined | null): value is string {
    if (!value) return false;
    return !REAL_VALUE_PLACEHOLDERS.has(value.toLowerCase().trim());
}

function buildYtPlaceholderWhere(): object[] {
    return [
        { title: { in: TITLE_PLACEHOLDERS } },
        { artist: { in: ARTIST_PLACEHOLDERS } },
        { album: { in: ALBUM_PLACEHOLDERS } },
    ];
}

class RemoteTrackMetadataRefreshService {
    /**
     * Find remote provider rows with placeholder metadata and re-fetch from provider APIs.
     */
    async refreshUnknownMetadata(
        batchSize: number = DEFAULT_BATCH_SIZE,
    ): Promise<{ updated: number; failed: number }> {
        const unknownYt = await prisma.trackYtMusic.findMany({
            where: {
                OR: buildYtPlaceholderWhere(),
            },
            select: { id: true, videoId: true },
            take: batchSize,
        });

        if (unknownYt.length === 0) {
            return { updated: 0, failed: 0 };
        }

        log.info(
            `Found ${unknownYt.length} YouTube Music rows with placeholder metadata`,
        );

        let updated = 0;
        let failed = 0;

        // Refresh YT Music rows
        if (unknownYt.length > 0) {
            log.debug(
                `Refreshing ${unknownYt.length} YT Music rows via __public__ metadata lookup`,
            );
            for (const row of unknownYt) {
                try {
                    const song = await ytMusicService.getSong(
                        "__public__",
                        row.videoId,
                    );
                    const ytUpdateData: Record<string, string | number> = {};
                    if (isRealValue(song?.title))
                        ytUpdateData.title = song.title;
                    if (isRealValue(song?.artist))
                        ytUpdateData.artist = song.artist;
                    if (isRealValue(song?.album))
                        ytUpdateData.album = song.album;
                    if (song?.duration && song.duration > 0)
                        ytUpdateData.duration = song.duration;

                    if (Object.keys(ytUpdateData).length > 0) {
                        await prisma.trackYtMusic.update({
                            where: { id: row.id },
                            data: ytUpdateData,
                        });
                        log.debug(
                            `Refreshed TrackYtMusic id=${row.id}: updated fields [${Object.keys(ytUpdateData).join(", ")}]`,
                        );
                        updated++;
                    } else {
                        log.debug(
                            `TrackYtMusic id=${row.id}: API returned no real metadata`,
                        );
                        failed++;
                    }
                } catch (err) {
                    log.warn(
                        `Failed to refresh TrackYtMusic id=${row.id}`,
                        err,
                    );
                    failed++;
                }
            }
        }

        log.info(
            `Metadata refresh complete: ${updated} updated, ${failed} failed`,
        );

        return { updated, failed };
    }
}

export const remoteTrackMetadataRefreshService =
    new RemoteTrackMetadataRefreshService();
