import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    formatPlaylistDetailTrack,
    normalizeYtMusicTrack,
} from "./unifiedTrackResponse";
import { ytMusicService, type YtMusicRadioTrack } from "./youtubeMusic";

const PLAYLIST_REMOTE_RADIO_SEED_LIMIT = 3;

function formatYtMusicRadioTrack(track: YtMusicRadioTrack) {
    return formatPlaylistDetailTrack(
        normalizeYtMusicTrack({
            id: `radio:${track.videoId}`,
            videoId: track.videoId,
            title: track.title,
            artist: track.artist,
            album: track.album,
            duration: track.duration,
            thumbnailUrl: track.thumbnailUrl,
            artistId: null,
            albumId: null,
        }),
    );
}

/** Build playable radio for playlists whose items only exist in YouTube Music. */
export async function buildRemotePlaylistRadio(
    playlistId: string,
    limit: number,
) {
    const items = await prisma.playlistItem.findMany({
        where: {
            playlistId,
            trackYtMusicId: { not: null },
            trackYtMusic: { isNot: null },
        },
        select: {
            trackYtMusic: {
                select: {
                    id: true,
                    videoId: true,
                    title: true,
                    artist: true,
                    album: true,
                    duration: true,
                    thumbnailUrl: true,
                    artistId: true,
                    albumId: true,
                },
            },
        },
        orderBy: { sort: "asc" },
        take: Math.max(limit, 25),
    });
    const playlistTracks = items
        .map((item) => item.trackYtMusic)
        .filter(
            (track): track is Exclude<typeof track, null> => track !== null,
        );
    if (playlistTracks.length === 0) return [];

    const seedVideoIds = Array.from(
        new Set(playlistTracks.map((track) => track.videoId)),
    ).slice(0, PLAYLIST_REMOTE_RADIO_SEED_LIMIT);
    const radioResults = await Promise.allSettled(
        seedVideoIds.map((videoId) => ytMusicService.getRadio(videoId, limit)),
    );
    const seedSet = new Set(seedVideoIds);
    const candidates = radioResults.flatMap((result) =>
        result.status === "fulfilled" ? result.value.tracks : [],
    );
    const seen = new Set<string>();
    const discoveredTracks = candidates
        .filter((track) => {
            if (seedSet.has(track.videoId) || seen.has(track.videoId)) {
                return false;
            }
            seen.add(track.videoId);
            return true;
        })
        .slice(0, limit)
        .map(formatYtMusicRadioTrack);

    if (discoveredTracks.length > 0) return discoveredTracks;

    logger.warn(
        `[Radio:playlist] YouTube Music radio returned no recommendations for ${playlistId}; falling back to playlist order`,
    );
    return playlistTracks
        .slice(0, limit)
        .map((track) =>
            formatPlaylistDetailTrack(normalizeYtMusicTrack(track)),
        );
}

/** Loads provider recommendations for one video without replaying its seed. */
export async function buildRemoteTrackRadio(videoId: string, limit: number) {
    const result = await ytMusicService.getRadio(videoId, limit);
    const seen = new Set([videoId]);
    return result.tracks
        .filter((track) => {
            if (seen.has(track.videoId)) return false;
            seen.add(track.videoId);
            return true;
        })
        .slice(0, limit)
        .map(formatYtMusicRadioTrack);
}

/** Builds radio from the authenticated user's recent remote likes. */
export async function buildRemoteLikedRadio(userId: string, limit: number) {
    const entries = await prisma.likedRemoteTrack.findMany({
        where: { userId, trackYtMusicId: { not: null } },
        select: { trackYtMusic: { select: { videoId: true } } },
        orderBy: { likedAt: "desc" },
        take: PLAYLIST_REMOTE_RADIO_SEED_LIMIT,
    });
    const seeds = [
        ...new Set(
            entries.flatMap((entry) =>
                entry.trackYtMusic ? [entry.trackYtMusic.videoId] : [],
            ),
        ),
    ];
    const results = await Promise.allSettled(
        seeds.map((seed) => buildRemoteTrackRadio(seed, limit)),
    );
    const seen = new Set(seeds);
    return results
        .flatMap((result) =>
            result.status === "fulfilled" ? result.value : [],
        )
        .filter((track) => {
            const id = String(track.youtubeVideoId);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        })
        .slice(0, limit);
}
